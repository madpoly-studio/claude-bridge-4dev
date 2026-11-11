// One worker slot (design §6): register → long-poll next → run task → repeat, with a heartbeat throughout.
import type { RegisterRunnerResponse } from "@claude-bridge/protocol";
import { BusClient } from "./busClient.js";
import type { ClaudeProcess } from "./claudeProcess.js";
import { readBootstrapToken, type RunnerConfig, type SlotConfig } from "./config.js";
import { errorMessage, type Logger } from "./logger.js";
import type { KillTreeFn } from "./processTree.js";
import { AbortedError, Backoff, sleep } from "./retry.js";
import { TaskRun } from "./taskRun.js";
import type { RunnerTimings } from "./timings.js";

/** During a long bus outage, log the first failed heartbeat and then every Nth. */
const HEARTBEAT_FAILURE_LOG_EVERY = 10;

export interface SlotRunnerOptions {
  config: RunnerConfig;
  slot: SlotConfig;
  timings: RunnerTimings;
  /** Aborting starts graceful shutdown: the running task is killed and reported, then run() resolves. */
  signal: AbortSignal;
  logger: Logger;
  /** Defaults to killProcessTree; tests inject a failing one. */
  killTree?: KillTreeFn;
}

export class SlotRunner {
  private readonly client: BusClient;
  private readonly logger: Logger;
  private currentRun: TaskRun | null = null;
  private heartbeatMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatFailures = 0;

  constructor(private readonly options: SlotRunnerOptions) {
    const { config, slot } = options;
    this.logger = options.logger.child(slot.worker_id);
    this.heartbeatMs = config.heartbeat_seconds * 1000;
    this.client = new BusClient({
      busUrl: config.bus_url,
      registration: { worker_id: slot.worker_id, repo: slot.repo, worktree_path: slot.worktree_path, host: config.host },
      getBootstrapToken: () => readBootstrapToken(config.bootstrap_token_file),
      getCurrentTaskId: () => this.currentRun?.taskId ?? null,
      onRegistered: (response) => this.onRegistered(response),
      requestTimeoutMs: options.timings.requestTimeoutMs,
      logger: this.logger,
    });
  }

  async run(): Promise<void> {
    const { signal } = this.options;
    try {
      await this.registerUntilAccepted();
      this.scheduleHeartbeat(0);
      await this.pollLoop();
    } catch (err) {
      if (!(err instanceof AbortedError)) {
        throw err;
      }
    } finally {
      this.stopHeartbeat();
      if (signal.aborted) {
        this.logger.info("slot stopped");
      }
    }
  }

  private async registerUntilAccepted(): Promise<void> {
    const backoff = new Backoff(this.options.timings.backoff);
    for (;;) {
      try {
        await this.client.register(this.options.signal);
        return;
      } catch (err) {
        if (err instanceof AbortedError) {
          throw err;
        }
        const delay = backoff.nextDelayMs();
        this.logger.error("registration failed, retrying", { retry_in_ms: delay, error: errorMessage(err) });
        await sleep(delay, this.options.signal);
      }
    }
  }

  private async pollLoop(): Promise<void> {
    const { signal, timings } = this.options;
    const backoff = new Backoff(timings.backoff);
    while (!signal.aborted) {
      let assignment;
      try {
        assignment = await this.client.next(timings.longPollWaitSeconds, signal);
      } catch (err) {
        if (err instanceof AbortedError) {
          return;
        }
        const delay = backoff.nextDelayMs();
        this.logger.warn("long-poll failed, retrying", { retry_in_ms: delay, error: errorMessage(err) });
        await sleep(delay, signal);
        continue;
      }
      backoff.reset();
      if (!assignment) {
        continue;
      }
      const taskLogger = this.logger.child(assignment.task.task_id);
      taskLogger.info("task received", { ticket: assignment.task.ticket_key, attempt: assignment.task.attempt });
      const run = new TaskRun({
        assignment,
        slot: this.options.slot,
        claudeCommand: this.options.config.claude_command,
        client: this.client,
        timings,
        shutdownSignal: signal,
        logger: taskLogger,
        killTree: this.options.killTree,
      });
      this.currentRun = run;
      let outcome;
      try {
        outcome = await run.execute();
      } finally {
        this.currentRun = null;
      }
      if (outcome.stuckProcess) {
        await this.quarantine(outcome.stuckProcess, taskLogger);
      }
    }
  }

  /**
   * A killed claude that would not die still owns the worktree: take no new task until it is gone. The
   * heartbeat keeps running (current_task_id null, the task was already reported) so the bus does not
   * mark the worker lost; the kill is retried on every poll. Returns early on shutdown.
   */
  private async quarantine(proc: ClaudeProcess, logger: Logger): Promise<void> {
    const { signal, timings } = this.options;
    logger.error("slot quarantined: claude did not terminate after kill; not taking tasks until it is gone", { pid: proc.pid });
    while (!proc.hasExited) {
      try {
        await sleep(timings.quarantinePollMs, signal);
      } catch (err) {
        if (err instanceof AbortedError) {
          logger.error("shutting down while a stuck claude process is still running", { pid: proc.pid });
          return;
        }
        throw err;
      }
      if (!proc.hasExited) {
        logger.error("slot quarantined: claude still running, retrying kill", { pid: proc.pid });
        await proc.kill();
      }
    }
    await proc.exited;
    logger.warn("stuck claude process is gone, slot takes tasks again", { pid: proc.pid });
  }

  private onRegistered(response: RegisterRunnerResponse): void {
    // Heartbeat at least as often as the bus expects.
    const busMs = response.heartbeat_seconds * 1000;
    const wanted = Math.min(this.options.config.heartbeat_seconds * 1000, busMs);
    if (wanted !== this.heartbeatMs) {
      this.logger.info("heartbeat interval adjusted to bus setting", { heartbeat_ms: wanted });
      this.heartbeatMs = wanted;
    }
    if (response.reconcile === "abort" && this.currentRun) {
      this.currentRun.kill("cancelled", "bus reconciliation: task no longer active");
    }
  }

  private scheduleHeartbeat(delayMs: number): void {
    if (this.options.signal.aborted) {
      return;
    }
    this.heartbeatTimer = setTimeout(() => void this.beat(), delayMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** One heartbeat; the next is scheduled only after this one settles, so beats never overlap. */
  private async beat(): Promise<void> {
    const run = this.currentRun;
    try {
      const response = await this.client.heartbeat({ current_task_id: run?.taskId ?? null }, this.options.signal);
      if (this.heartbeatFailures > 0) {
        this.logger.info("heartbeat recovered", { failed_beats: this.heartbeatFailures });
        this.heartbeatFailures = 0;
      }
      if (response.cancel) {
        this.handleCancel(response.task_id ?? null);
      }
    } catch (err) {
      if (err instanceof AbortedError) {
        return;
      }
      this.heartbeatFailures += 1;
      if (this.heartbeatFailures === 1 || this.heartbeatFailures % HEARTBEAT_FAILURE_LOG_EVERY === 0) {
        this.logger.warn("heartbeat failed", { failed_beats: this.heartbeatFailures, error: errorMessage(err) });
      }
    }
    this.scheduleHeartbeat(this.heartbeatMs);
  }

  private handleCancel(taskId: string | null): void {
    const run = this.currentRun;
    if (!run) {
      this.logger.debug("cancel received while idle, ignoring", { task_id: taskId });
      return;
    }
    if (taskId !== null && taskId !== run.taskId) {
      this.logger.warn("cancel for a task this slot is not running, ignoring", { task_id: taskId, running: run.taskId });
      return;
    }
    run.kill("cancelled", "cancelled by bus");
  }
}
