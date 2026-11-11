// One assigned task, end to end (design §6 steps 3-8): worktree check → spawn → started → events → exited.
import { BUS_MCP_SERVER_NAME, type NextTaskResponse, type TaskExitedRequest } from "@claude-bridge/protocol";
import { isRetryableBusError, type BusClient } from "./busClient.js";
import { buildClaudeArgs, writeMcpConfigFile } from "./claudeInvocation.js";
import { ClaudeProcess, SpawnError, type ClaudeExit } from "./claudeProcess.js";
import { BOOTSTRAP_TOKEN_ENV, type SlotConfig } from "./config.js";
import { EventForwarder } from "./eventForwarder.js";
import { errorMessage, type Logger } from "./logger.js";
import { AbortedError, graceSignal, retry } from "./retry.js";
import { busMcpStatus, initSessionId, isResultEvent, parseJsonObjectLine, usageFromResult } from "./streamJson.js";
import type { RunnerTimings } from "./timings.js";
import { checkWorktree } from "./worktree.js";

/** Characters of stderr included in the exited message of a failed run (the full tail is logged locally). */
const EXIT_MESSAGE_STDERR_CHARS = 1000;
/** setTimeout cannot represent longer delays (about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;
const SHUTDOWN_MESSAGE = "runner shutdown";

/** "shutdown" is reported as reason null so the bus records no_terminal_report. */
export type KillReason = "timeout" | "cancelled" | "shutdown";

export interface TaskRunOptions {
  assignment: NextTaskResponse;
  slot: SlotConfig;
  claudeCommand: readonly string[];
  client: BusClient;
  timings: RunnerTimings;
  shutdownSignal: AbortSignal;
  logger: Logger;
}

export class TaskRun {
  readonly taskId: string;
  private readonly logger: Logger;
  /** Bounds reporting retries: unlimited normally, `shutdownGraceMs` once shutdown starts. */
  private readonly reportGrace: { signal: AbortSignal; dispose: () => void };
  private killRequest: { reason: KillReason; message: string } | null = null;
  private process: ClaudeProcess | null = null;

  constructor(private readonly options: TaskRunOptions) {
    this.taskId = options.assignment.task.task_id;
    this.logger = options.logger;
    this.reportGrace = graceSignal(options.shutdownSignal, options.timings.shutdownGraceMs);
  }

  private get reportSignal(): AbortSignal {
    return this.reportGrace.signal;
  }

  /** Requests termination; the first reason wins. Safe to call at any stage. */
  kill(reason: KillReason, message: string): void {
    if (this.killRequest) {
      return;
    }
    this.killRequest = { reason, message };
    this.logger.warn("stopping task", { reason, message });
    void this.process?.kill();
  }

  /** Runs to completion and reports `exited`. Never throws. */
  async execute(): Promise<void> {
    const onShutdown = (): void => this.kill("shutdown", SHUTDOWN_MESSAGE);
    if (this.options.shutdownSignal.aborted) {
      onShutdown();
    }
    this.options.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
    try {
      let exit: TaskExitedRequest;
      try {
        exit = await this.run();
      } catch (err) {
        this.logger.error("unexpected error while running task", { error: errorMessage(err) });
        exit = { exit_code: null, usage: null, reason: "spawn_error", message: `runner error: ${errorMessage(err)}` };
      }
      await this.report("exited", (signal) => this.options.client.exited(this.taskId, exit, signal));
      this.logger.info("task finished", { exit_code: exit.exit_code, reason: exit.reason ?? null });
    } finally {
      this.options.shutdownSignal.removeEventListener("abort", onShutdown);
      this.reportGrace.dispose();
    }
  }

  private async run(): Promise<TaskExitedRequest> {
    const { slot, assignment } = this.options;
    let status;
    try {
      status = await checkWorktree(slot.worktree_path);
    } catch (err) {
      return this.notSpawned("spawn_error", errorMessage(err));
    }
    if (!status.clean) {
      this.logger.warn("worktree is dirty, not spawning", { worktree: slot.worktree_path });
      return this.notSpawned("conflict", status.summary);
    }
    if (this.killRequest) {
      return this.killedExit(null, null);
    }

    let mcpConfig;
    try {
      mcpConfig = await writeMcpConfigFile(assignment.mcp_url, assignment.task_token);
    } catch (err) {
      return this.notSpawned("spawn_error", `cannot write MCP config file: ${errorMessage(err)}`);
    }
    try {
      return await this.spawnAndWatch(mcpConfig.path);
    } finally {
      await mcpConfig.dispose();
    }
  }

  private async spawnAndWatch(mcpConfigPath: string): Promise<TaskExitedRequest> {
    const { slot, assignment, timings } = this.options;
    const forwarder = new EventForwarder({
      send: (events, signal) => this.options.client.events(this.taskId, { events }, signal),
      flushIntervalMs: timings.eventFlushIntervalMs,
      maxBatch: timings.eventMaxBatch,
      maxBuffered: timings.eventMaxBuffered,
      backoff: timings.backoff,
      signal: this.reportSignal,
      logger: this.logger,
    });
    let lastResult: Record<string, unknown> | null = null;
    let started: Promise<void> | null = null;
    let fallbackTimer: NodeJS.Timeout | undefined;
    const requestStarted = (sessionId: string | null): void => {
      if (started) {
        return;
      }
      clearTimeout(fallbackTimer);
      started = this.postStarted(sessionId, this.process?.pid ?? null).finally(() => forwarder.open());
    };

    let proc: ClaudeProcess;
    try {
      proc = await ClaudeProcess.start({
        command: this.options.claudeCommand,
        args: buildClaudeArgs(slot, mcpConfigPath),
        cwd: slot.worktree_path,
        env: childEnv(slot),
        prompt: assignment.prompt,
        killGraceMs: timings.killGraceMs,
        stdioDrainMs: timings.stdioDrainMs,
        logger: this.logger,
        onLine: (line) => {
          const event = parseJsonObjectLine(line);
          if (!event) {
            forwarder.push({ type: "raw", text: line });
            return;
          }
          const sessionId = initSessionId(event);
          if (sessionId !== undefined) {
            this.checkBusMcp(event);
            requestStarted(sessionId);
          }
          if (isResultEvent(event)) {
            lastResult = event;
          }
          forwarder.push(event);
        },
      });
    } catch (err) {
      await forwarder.close();
      if (err instanceof SpawnError) {
        return this.notSpawned("spawn_error", err.message);
      }
      throw err;
    }
    this.process = proc;
    this.logger.info("claude started", { pid: proc.pid, timeout_s: assignment.timeout_seconds });
    if (this.killRequest) {
      void proc.kill();
    }

    fallbackTimer = setTimeout(() => {
      this.logger.warn("no init line from claude, reporting started without session_id", { after_ms: timings.startedFallbackMs });
      requestStarted(null);
    }, timings.startedFallbackMs);
    const timeoutTimer = setTimeout(
      () => this.kill("timeout", `task exceeded timeout of ${assignment.timeout_seconds}s`),
      Math.min(assignment.timeout_seconds * 1000, MAX_TIMER_MS),
    );

    const exit = await proc.exited;
    clearTimeout(fallbackTimer);
    clearTimeout(timeoutTimer);
    // The process did run; the bus needs `started` before events and exited make sense.
    requestStarted(null);
    await started;
    const delivery = await forwarder.close();
    return this.exitRequest(exit, usageFromResult(lastResult), delivery.dropped);
  }

  private exitRequest(exit: ClaudeExit, usage: TaskExitedRequest["usage"], dropped: number): TaskExitedRequest {
    if (exit.code !== 0 && !this.killRequest && exit.stderrTail.trim()) {
      this.logger.warn("claude exited with error", { code: exit.code, signal: exit.signal, stderr_tail: exit.stderrTail.trim() });
    }
    const result = this.killRequest ? this.killedExit(exit.code, usage) : this.normalExit(exit, usage);
    if (dropped > 0) {
      result.message = `${result.message ? `${result.message}; ` : ""}${dropped} stream event(s) were not delivered`;
    }
    return result;
  }

  private normalExit(exit: ClaudeExit, usage: TaskExitedRequest["usage"]): TaskExitedRequest {
    if (exit.code === 0) {
      return { exit_code: 0, usage, reason: null, message: null };
    }
    const how = exit.code !== null ? `code ${exit.code}` : `signal ${exit.signal ?? "unknown"}`;
    const tail = exit.stderrTail.trim().slice(-EXIT_MESSAGE_STDERR_CHARS);
    return { exit_code: exit.code, usage, reason: null, message: `claude exited with ${how}${tail ? `; stderr: ${tail}` : ""}` };
  }

  private killedExit(exitCode: number | null, usage: TaskExitedRequest["usage"]): TaskExitedRequest {
    const kill = this.killRequest as { reason: KillReason; message: string };
    return { exit_code: exitCode, usage, reason: kill.reason === "shutdown" ? null : kill.reason, message: kill.message };
  }

  private notSpawned(reason: "conflict" | "spawn_error", message: string): TaskExitedRequest {
    if (reason === "spawn_error") {
      this.logger.error("cannot start task", { message });
    }
    return { exit_code: null, usage: null, reason, message };
  }

  private async postStarted(sessionId: string | null, pid: number | null): Promise<void> {
    const accepted = await this.report("started", (signal) =>
      this.options.client.started(this.taskId, { session_id: sessionId, pid }, signal),
    );
    if (accepted === "rejected") {
      // The bus no longer considers this task active (cancelled, timed out on its side): stop working on it.
      this.kill("cancelled", "bus rejected started");
    } else if (accepted === "ok") {
      this.logger.info("reported started", { session_id: sessionId, pid });
    }
  }

  /** POST with retry. "rejected" = permanent 4xx, "aborted" = shutdown deadline hit. */
  private async report(what: string, send: (signal: AbortSignal) => Promise<void>): Promise<"ok" | "rejected" | "aborted"> {
    try {
      await retry(() => send(this.reportSignal), {
        what: `posting ${what}`,
        logger: this.logger,
        backoff: this.options.timings.backoff,
        signal: this.reportSignal,
        isRetryable: isRetryableBusError,
      });
      return "ok";
    } catch (err) {
      if (err instanceof AbortedError) {
        this.logger.error(`${what} not delivered before shutdown deadline`);
        return "aborted";
      }
      this.logger.error(`bus rejected ${what}`, { error: errorMessage(err) });
      return "rejected";
    }
  }

  private checkBusMcp(initEvent: Record<string, unknown>): void {
    const status = busMcpStatus(initEvent, BUS_MCP_SERVER_NAME);
    if (status !== undefined && status !== "connected") {
      this.logger.warn("claude could not connect to the bus MCP server; the task cannot report its result", { status });
    }
  }
}

/** Runner env + slot env, without the bootstrap token (a worker must not be able to register runners). */
function childEnv(slot: SlotConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...slot.env };
  delete env[BOOTSTRAP_TOKEN_ENV];
  return env;
}
