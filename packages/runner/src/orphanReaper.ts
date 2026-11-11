// Kills what claude leaves behind after it exits (dev servers, watchers started from its Bash tool, ...),
// so they cannot keep writing to or locking files in the worktree that the next task checks.
import type { ChildProcess } from "node:child_process";
import { errorMessage, type Logger } from "./logger.js";
import { DescendantSet, fileTimeFromMs, takeProcessSnapshot, type ProcessEntry } from "./processSnapshot.js";
import { killProcessGroupNow, taskkillTrees } from "./processTree.js";

/** Snapshot failures are logged the first time and then every Nth time (one scan per `scanIntervalMs`). */
const SNAPSHOT_FAILURE_LOG_EVERY = 30;
/** Spawn time is taken just before spawn(); the OS creation time can only be later, minus clock granularity. */
const ROOT_CREATION_SLACK_MS = 1_000;

export interface OrphanReaper {
  /** Stops tracking and kills every leftover descendant. Call once, after the process exited. Never throws. */
  reap(): Promise<void>;
}

export interface OrphanReaperOptions {
  /** Date.now() taken right before spawn(). */
  spawnedAtMs: number;
  /** win32 only: interval between process-table snapshots. */
  scanIntervalMs: number;
  logger: Logger;
  /** win32 only; tests replace it. */
  snapshot?: () => Promise<ProcessEntry[]>;
}

/**
 * POSIX: the child leads its own process group (spawned detached), so one SIGKILL to the group after it
 * exits takes every survivor (except processes that called setsid themselves).
 * win32: no process groups and no reparenting, so descendants are recorded from periodic snapshots while
 * the child runs, then re-checked (pid + creation time) and killed after it exits.
 */
export function startOrphanReaper(child: ChildProcess, options: OrphanReaperOptions): OrphanReaper {
  const pid = child.pid as number;
  if (process.platform !== "win32") {
    return {
      reap: async () => {
        if (killProcessGroupNow(pid, options.logger)) {
          options.logger.warn("killed processes left behind by claude in its process group", { pid });
        }
      },
    };
  }
  return new WindowsOrphanReaper(pid, options);
}

/** Snapshots run one at a time (next one scheduled after the previous settles); each costs one powershell.exe. */
export class WindowsOrphanReaper implements OrphanReaper {
  private readonly snapshot: () => Promise<ProcessEntry[]>;
  private descendants: DescendantSet | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private snapshotFailures = 0;

  constructor(
    private readonly pid: number,
    private readonly options: OrphanReaperOptions,
  ) {
    this.snapshot = options.snapshot ?? takeProcessSnapshot;
    this.schedule(0);
  }

  async reap(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    let snapshot: ProcessEntry[];
    try {
      snapshot = await this.snapshot();
    } catch (err) {
      this.options.logger.warn("cannot check for processes left behind by claude", { pid: this.pid, error: errorMessage(err) });
      return;
    }
    const leftovers = this.record(snapshot);
    if (leftovers.length === 0) {
      return;
    }
    const pids = leftovers.map((p) => p.pid);
    this.options.logger.warn("killing processes left behind by claude", { pid: this.pid, leftovers: pids.join(",") });
    await taskkillTrees(pids, this.options.logger);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.scan().finally(() => {
        this.inFlight = null;
        this.schedule(this.options.scanIntervalMs);
      });
    }, delayMs);
  }

  private async scan(): Promise<void> {
    try {
      this.record(await this.snapshot());
      this.snapshotFailures = 0;
    } catch (err) {
      this.snapshotFailures += 1;
      if (this.snapshotFailures === 1 || this.snapshotFailures % SNAPSHOT_FAILURE_LOG_EVERY === 0) {
        this.options.logger.warn("process snapshot failed; leftover processes may not be cleaned up", {
          pid: this.pid,
          failures: this.snapshotFailures,
          error: errorMessage(err),
        });
      }
    }
  }

  private record(snapshot: ProcessEntry[]): ProcessEntry[] {
    if (!this.descendants) {
      // The first successful snapshot pins the root's creation time; if the root is already gone, use the spawn time.
      const earliest = fileTimeFromMs(this.options.spawnedAtMs - ROOT_CREATION_SLACK_MS);
      const self = snapshot.find((p) => p.pid === this.pid && p.created >= earliest);
      this.descendants = new DescendantSet({ pid: this.pid, created: self?.created ?? earliest });
    }
    this.descendants.record(snapshot);
    return this.descendants.descendants();
  }
}
