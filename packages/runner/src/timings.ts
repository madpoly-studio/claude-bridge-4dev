// Internal timing knobs. Not part of runner.config.json; tests override them to run fast.
import { DEFAULTS } from "@claude-bridge/protocol";
import type { BackoffOptions } from "./retry.js";

export interface RunnerTimings {
  /** Post `started{session_id:null}` if no init line arrived within this time after spawn. */
  startedFallbackMs: number;
  eventFlushIntervalMs: number;
  eventMaxBatch: number;
  eventMaxBuffered: number;
  /** POSIX: SIGTERM → SIGKILL delay. */
  killGraceMs: number;
  /** After shutdown starts, how long final events/exited posts may keep retrying. */
  shutdownGraceMs: number;
  /** After the child exits, how long to wait for stdout/stderr to close (a grandchild may hold them). */
  stdioDrainMs: number;
  /** win32: interval between process-tree snapshots that record claude's descendants (reaped after it exits). */
  descendantScanMs: number;
  /** After a kill, how long to wait for the process to exit before reporting it and quarantining the slot. */
  killDeadlineMs: number;
  /** While quarantined: how often to check whether the stuck process is gone (and retry the kill). */
  quarantinePollMs: number;
  longPollWaitSeconds: number;
  requestTimeoutMs: number;
  backoff: BackoffOptions;
}

export const DEFAULT_TIMINGS: RunnerTimings = {
  startedFallbackMs: 10_000,
  eventFlushIntervalMs: 500,
  eventMaxBatch: 50,
  eventMaxBuffered: 10_000,
  killGraceMs: 5_000,
  shutdownGraceMs: 15_000,
  stdioDrainMs: 2_000,
  descendantScanMs: 2_000,
  killDeadlineMs: 30_000,
  quarantinePollMs: 5_000,
  longPollWaitSeconds: DEFAULTS.LONG_POLL_WAIT_SECONDS,
  requestTimeoutMs: 15_000,
  backoff: { baseMs: 500, capMs: 10_000 },
};
