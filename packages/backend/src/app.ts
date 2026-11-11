// Dựng backend: Fastify (chỉ 127.0.0.1) + Task Bus + MCP + WS hub + Session Manager / Permission Broker /
// Wake Dispatcher / Jira Reader. Test dùng `createApp` với port 0, DB tạm và FakeClaudeDriver.
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { BUS_MCP_PATH } from "@claude-bridge/protocol";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { type BusModule, createBus, registerBusRoutes } from "./bus/index.js";
import { resolveRunnerBootstrapToken } from "./bus/tokens.js";
import type { ClaudeDriver } from "./claude/driver.js";
import { SdkClaudeDriver } from "./claude/sdkDriver.js";
import { BIND_HOST, type BridgeConfig } from "./config.js";
import { type Db, openDatabase } from "./db/database.js";
import { EventLog } from "./events/eventLog.js";
import { type JiraModule, createJiraModule } from "./jira/jiraModule.js";
import { type AgentModule, createAgentModule } from "./sessions/agentModule.js";
import type { RestartPolicy } from "./sessions/orchestrators.js";
import { StatusService } from "./status/statusService.js";
import { type Clock, systemClock } from "./util/clock.js";
import { randomToken } from "./util/ids.js";
import { type Timers, systemTimers } from "./util/timers.js";
import { PairingTokenVerifier, type TokenVerifier } from "./ws/auth.js";
import { connectBusToHub } from "./ws/busBridge.js";
import { WS_PATH, WsHub } from "./ws/hub.js";

export const SERVER_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export interface AppOptions {
  clock?: Clock;
  /** Mặc định `<data_dir>/bridge.db`. */
  dbPath?: string;
  logger?: FastifyServerOptions["logger"];
  /** Chu kỳ sweeper (mục 7.8); 0 = tắt (test gọi `sweeper.sweep()` trực tiếp). */
  sweepIntervalMs?: number;
  wsAuthTimeoutMs?: number;
  /** Thay pairing token bằng cơ chế khác (JWT SSO sau này). */
  tokenVerifier?: TokenVerifier;
  /** Mặc định SdkClaudeDriver (Agent SDK thật); test truyền FakeClaudeDriver. */
  claudeDriver?: ClaudeDriver;
  /** Timer cho debounce wake, tick, poll Jira, backoff orchestrator. */
  timers?: Timers;
  orchestratorRestartPolicy?: RestartPolicy;
}

export interface BridgeApp extends BusModule {
  config: BridgeConfig;
  app: FastifyInstance;
  db: Db;
  eventLog: EventLog;
  status: StatusService;
  hub: WsHub;
  /** Session Manager, Permission Broker, orchestrator, Wake Dispatcher. */
  agents: AgentModule;
  jira: JiraModule;
  pairingToken: string;
  runnerBootstrapToken: string;
  /** `http://127.0.0.1:<port>` (port thật sau listen). */
  baseUrl(): string;
  mcpUrl(): string;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

export async function createApp(config: BridgeConfig, opts: AppOptions = {}): Promise<BridgeApp> {
  const clock = opts.clock ?? systemClock;
  // Tạo driver thật trước mọi tài nguyên: auth mode `api_key` thiếu ANTHROPIC_API_KEY làm backend dừng ngay lúc khởi động.
  // Logger của Fastify chỉ được dùng khi driver chạy, lúc đó `app` đã tồn tại.
  const driver =
    opts.claudeDriver ??
    new SdkClaudeDriver({
      authMode: config.claude_auth_mode,
      executable: config.claude_executable,
      clientApp: `claude-bridge/${SERVER_VERSION}`,
      log: { warn: (obj, msg) => app.log.warn(obj, msg), debug: (obj, msg) => app.log.debug(obj, msg) },
    });
  const db = openDatabase(opts.dbPath ?? join(config.data_dir, "bridge.db"));
  const eventLog = new EventLog(db, clock);
  const runnerBootstrapToken = resolveRunnerBootstrapToken(config.runner_bootstrap_token, config.data_dir);
  const pairingToken = config.pairing_token ?? randomToken();

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: BODY_LIMIT_BYTES });
  const baseUrl = (): string => {
    const address = app.server.address() as AddressInfo | null;
    return `http://${BIND_HOST}:${address?.port ?? config.port}`;
  };
  const mcpUrl = (): string => `${baseUrl()}${BUS_MCP_PATH}`;

  const mod = createBus({ db, eventLog, clock, settings: config, runnerBootstrapToken, mcpUrl });
  const status = new StatusService(mod.bus, mod.core);

  const hub = new WsHub({
    allowedOrigins: config.allowed_origins,
    verifier: opts.tokenVerifier ?? new PairingTokenVerifier(pairingToken),
    authTimeoutMs: opts.wsAuthTimeoutMs,
    authOk: () => ({ server_version: SERVER_VERSION, projects: config.projects, repos: config.repos }),
    snapshotCore: () => ({
      workers: mod.bus.listWorkers(),
      tasks: mod.bus.listRecentTasks(),
      status: status.get(),
      last_seq: eventLog.lastSeq(),
    }),
    replay: (since) => eventLog.readBusEventsSince(since),
    log: app.log,
  });
  const disconnectBridge = connectBusToHub({ hub, core: mod.core, bus: mod.bus, eventLog, status });
  hub.attach(app.server);

  const timers = opts.timers ?? systemTimers;
  const agents = createAgentModule({
    config,
    db,
    eventLog,
    bus: mod.bus,
    hub,
    status,
    clock,
    timers,
    driver,
    mcpUrl,
    orchestratorToken: () => mod.tokens.getOrchestratorToken(),
    log: app.log,
    ...(opts.orchestratorRestartPolicy ? { restartPolicy: opts.orchestratorRestartPolicy } : {}),
  });
  // Sau connectBusToHub: thay handler `tickets.refresh` của Phase 1.
  const jira = createJiraModule({ config, eventLog, hub, status, timers, log: app.log });

  app.get("/health", async () => ({ ok: true, version: SERVER_VERSION }));
  await registerBusRoutes(app, mod, SERVER_VERSION);

  let closed = false;
  return {
    ...mod,
    config,
    app,
    db,
    eventLog,
    status,
    hub,
    agents,
    jira,
    pairingToken,
    runnerBootstrapToken,
    baseUrl,
    mcpUrl,
    async listen() {
      // Host cố định loopback (mục 12), không lấy từ cấu hình.
      await app.listen({ host: BIND_HOST, port: config.port });
      mod.sweeper.start(opts.sweepIntervalMs);
      jira.start();
      agents.start();
      return { port: (app.server.address() as AddressInfo).port };
    },
    async close() {
      if (closed) return;
      closed = true;
      jira.close();
      // Trước khi đóng DB: process Claude dừng, session để ở `detached` để resume sau.
      await agents.close();
      mod.sweeper.stop();
      mod.runners.close();
      disconnectBridge();
      await hub.close();
      await app.close();
      db.close();
    },
  };
}

export { WS_PATH };
