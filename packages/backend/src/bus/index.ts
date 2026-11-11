// Ghép các phần của Task Bus. Module khác chỉ nên dùng `TaskBus` (API công khai) và `BusCore` listeners.
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/database.js";
import type { EventLog } from "../events/eventLog.js";
import type { Clock } from "../util/clock.js";
import { BusCore, type BusSettings } from "./busCore.js";
import { registerMcpEndpoint } from "./mcpEndpoint.js";
import { BusRepository } from "./repository.js";
import { busErrorHandler, registerRunnerRoutes } from "./runnerRoutes.js";
import { RunnerService } from "./runnerService.js";
import { Sweeper } from "./sweeper.js";
import { TaskBus } from "./taskBus.js";
import { BusTokens } from "./tokens.js";
import { TaskWaiters } from "./waiters.js";

export interface BusModule {
  core: BusCore;
  bus: TaskBus;
  runners: RunnerService;
  sweeper: Sweeper;
  tokens: BusTokens;
}

export interface CreateBusOptions {
  db: Db;
  eventLog: EventLog;
  clock: Clock;
  settings: BusSettings;
  runnerBootstrapToken: string;
  mcpUrl: () => string;
}

export function createBus(opts: CreateBusOptions): BusModule {
  const repo = new BusRepository(opts.db);
  const core = new BusCore(opts.db, repo, opts.eventLog, opts.clock, opts.settings);
  const bus = new TaskBus(core);
  const runners = new RunnerService(core, bus, new TaskWaiters(), opts.mcpUrl);
  return { core, bus, runners, sweeper: new Sweeper(core), tokens: new BusTokens(opts.runnerBootstrapToken) };
}

/** Mount API runner + endpoint MCP trong một plugin riêng (error handler riêng của bus). */
export async function registerBusRoutes(app: FastifyInstance, mod: BusModule, serverVersion: string): Promise<void> {
  await app.register(async (scope) => {
    scope.setErrorHandler(busErrorHandler);
    registerRunnerRoutes(scope, { runners: mod.runners, tokens: mod.tokens });
    registerMcpEndpoint(scope, { bus: mod.bus, tokens: mod.tokens, serverVersion });
  });
}

export { BusError } from "./errors.js";
export type { BusStatus, TicketCreatedInput } from "./taskBus.js";
export type { BusSettings } from "./busCore.js";
export { TaskBus, BusCore, RunnerService, Sweeper, BusTokens };
