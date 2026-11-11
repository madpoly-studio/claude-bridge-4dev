// Dựng backend: Fastify (chỉ 127.0.0.1) + Task Bus + MCP + WS hub. Test dùng `createApp` với port 0 và DB tạm.
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { BUS_MCP_PATH } from "@claude-bridge/protocol";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { type BusModule, createBus, registerBusRoutes } from "./bus/index.js";
import { resolveRunnerBootstrapToken } from "./bus/tokens.js";
import { BIND_HOST, type BridgeConfig } from "./config.js";
import { type Db, openDatabase } from "./db/database.js";
import { EventLog } from "./events/eventLog.js";
import { StatusService } from "./status/statusService.js";
import { type Clock, systemClock } from "./util/clock.js";
import { randomToken } from "./util/ids.js";
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
}

export interface BridgeApp extends BusModule {
  config: BridgeConfig;
  app: FastifyInstance;
  db: Db;
  eventLog: EventLog;
  status: StatusService;
  hub: WsHub;
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
    pairingToken,
    runnerBootstrapToken,
    baseUrl,
    mcpUrl,
    async listen() {
      // Host cố định loopback (mục 12), không lấy từ cấu hình.
      await app.listen({ host: BIND_HOST, port: config.port });
      mod.sweeper.start(opts.sweepIntervalMs);
      return { port: (app.server.address() as AddressInfo).port };
    },
    async close() {
      if (closed) return;
      closed = true;
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
