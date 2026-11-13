// Ghép Session Manager + Permission Broker + orchestrator + Wake Dispatcher + hạn mức seat vào hub / status.
import type { ClaudeDriver } from "../claude/driver.js";
import { SeatTracker } from "../claude/seatTracker.js";
import type { TaskBus } from "../bus/taskBus.js";
import type { BridgeConfig } from "../config.js";
import type { Db } from "../db/database.js";
import type { EventLog } from "../events/eventLog.js";
import { PermissionBroker } from "../permissions/permissionBroker.js";
import { PermissionStore } from "../permissions/permissionStore.js";
import type { StatusService } from "../status/statusService.js";
import type { Clock } from "../util/clock.js";
import type { Unsubscribe } from "../util/listeners.js";
import type { Logger } from "../util/logger.js";
import type { Timers } from "../util/timers.js";
import { WakeDispatcher } from "../wake/wakeDispatcher.js";
import type { WsHub } from "../ws/hub.js";
import { OrchestratorManager, type RestartPolicy } from "./orchestrators.js";
import { SessionProfiles } from "./profiles.js";
import { ProjectSelection } from "./projectSelection.js";
import { SessionManager } from "./sessionManager.js";
import { SessionStore } from "./sessionStore.js";
import { WelcomeAnnouncer } from "./welcome.js";
import { registerSessionHandlers } from "./wsHandlers.js";

export interface AgentModuleDeps {
  config: BridgeConfig;
  db: Db;
  eventLog: EventLog;
  bus: TaskBus;
  hub: WsHub;
  status: StatusService;
  clock: Clock;
  timers: Timers;
  driver: ClaudeDriver;
  mcpUrl: () => string;
  orchestratorToken: (projectKey: string) => string;
  log: Logger;
  restartPolicy?: RestartPolicy;
}

export interface AgentModule {
  sessions: SessionManager;
  orchestrators: OrchestratorManager;
  broker: PermissionBroker;
  wake: WakeDispatcher;
  seat: SeatTracker;
  selection: ProjectSelection;
  profiles: SessionProfiles;
  /** Sau khi HTTP đã listen (orchestrator cần URL MCP với port thật). */
  start(): void;
  close(): Promise<void>;
}

export function createAgentModule(deps: AgentModuleDeps): AgentModule {
  const { config, db, eventLog, bus, hub, status, clock, timers, log } = deps;

  const store = new SessionStore(db, clock);
  const detached = store.detachOpenSessions();
  const broker = new PermissionBroker({ store: new PermissionStore(db, clock), bus, log });
  const expired = broker.expireAllStored();
  if (detached > 0 || expired > 0) log.info({ detached, expired_permissions: expired }, "sessions detached after restart");

  const profiles = new SessionProfiles({ config, broker, mcpUrl: deps.mcpUrl, orchestratorToken: deps.orchestratorToken });
  const sessions = new SessionManager({
    store,
    eventLog,
    driver: deps.driver,
    clock,
    optionsFor: (row) => profiles.optionsFor(row),
    log,
  });
  const orchestrators = new OrchestratorManager({ config, sessions, timers, clock, log, ...(deps.restartPolicy ? { policy: deps.restartPolicy } : {}) });
  const selection = new ProjectSelection(config.projects);
  const seat = new SeatTracker(clock, () => status.notifyChanged());
  const wake = new WakeDispatcher({
    eventLog,
    target: orchestrators,
    timers,
    debounceMs: config.wake_debounce_seconds * 1000,
    tickMs: config.orch_tick_minutes * 60_000,
    mode: config.wake_mode,
    log,
  });
  const welcome = new WelcomeAnnouncer({ config, sessions, clock, log });

  const unsubscribers: Unsubscribe[] = [
    sessions.onUpdated((s) => hub.broadcast("session.updated", s)),
    sessions.onMessage(({ session_id, role, message }) => {
      seat.observe(message);
      if (role === "planner") broker.observe(session_id, message);
    }),
    // Query mất thì request đang chờ không còn ai nhận quyết định.
    sessions.onEnded(({ session }) => broker.expireSession(session.session_id)),
    broker.onRequest((r) => hub.broadcast("permission.request", r)),
    broker.onResolved((r) => hub.broadcast("permission.resolved", r)),
    orchestrators.onHealthChanged(({ project }) => {
      if (project === selection.current()) status.notifyChanged();
    }),
    status.registerContributor(() => ({
      project_key: selection.current(),
      orchestrator: orchestrators.health(selection.current()),
      ...seat.status(),
    })),
    hub.registerSnapshotContributor(() => ({
      sessions: sessions.snapshotSessions(selection.current()),
      pending_permissions: broker.listPending(),
    })),
  ];
  registerSessionHandlers({ hub, config, sessions, orchestrators, broker, selection, status });

  return {
    sessions,
    orchestrators,
    broker,
    wake,
    seat,
    selection,
    profiles,
    start() {
      wake.start();
      welcome.start();
      if (config.orchestrator_autostart) orchestrators.startAll();
    },
    async close() {
      wake.stop();
      welcome.stop();
      orchestrators.stop();
      await sessions.shutdown();
      for (const off of unsubscribers) off();
    },
  };
}
