// Phát hiện lỗi theo thời gian (mục 7.8). Chạy định kỳ; test gọi `sweep()` trực tiếp với clock giả.
import { fromIso } from "../util/clock.js";
import type { BusCore } from "./busCore.js";

/** Backstop cho TASK_TIMEOUT: runner tự kill trước; bus chỉ can thiệp nếu runner im lặng quá thêm khoảng này. */
export const TASK_TIMEOUT_BACKSTOP_MS = 5 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL_MS = 5_000;

export interface SweepResult {
  unresponsive: string[];
  lostWorkers: string[];
  timedOut: string[];
}

export class Sweeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly core: BusCore) {}

  start(intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        console.error("[bus.sweeper] sweep failed:", err);
      }
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Mốc thời gian dùng cho timeout được kẹp ở `startedAt` của bus: sau restart, runner có
   * ân hạn đủ một chu kỳ để đăng ký lại trước khi bị coi là mất liên lạc.
   */
  sweep(): SweepResult {
    const { core } = this;
    const { settings, repo } = core;
    const now = core.clock.now();
    const since = (iso: string | null): number => Math.max(iso ? fromIso(iso) : 0, core.startedAt);
    const result: SweepResult = { unresponsive: [], lostWorkers: [], timedOut: [] };

    // 1. assigned quá ASSIGN_START_TIMEOUT mà chưa started → failed(runner_unresponsive), worker offline.
    const startLimit = settings.assign_start_timeout_seconds * 1000;
    for (const task of repo.listTasks({ state: "assigned" })) {
      if (now - since(task.assigned_at) <= startLimit) continue;
      core.run((tx) => {
        const current = repo.getTask(task.task_id);
        if (current?.state !== "assigned") return;
        core.markWorkerOffline(
          tx,
          current.worker_id,
          "runner_unresponsive",
          "runner_unresponsive",
          `task not started within ${settings.assign_start_timeout_seconds}s`,
        );
        result.unresponsive.push(current.task_id);
      });
    }

    // 2. Mất heartbeat → worker offline, task active của nó failed(runner_lost).
    const lostLimit = settings.heartbeat_lost_seconds * 1000;
    for (const worker of repo.listWorkers()) {
      if (worker.state === "offline") continue;
      if (now - since(worker.last_heartbeat) <= lostLimit) continue;
      core.run((tx) => {
        const current = repo.getWorker(worker.worker_id);
        if (!current || current.state === "offline") return;
        core.markWorkerOffline(tx, current.worker_id, "heartbeat_lost", "runner_lost", `no heartbeat for ${settings.heartbeat_lost_seconds}s`);
        result.lostWorkers.push(current.worker_id);
      });
    }

    // 3. Backstop TASK_TIMEOUT (runner lẽ ra đã kill và báo exited{reason:"timeout"}).
    const timeoutLimit = settings.task_timeout_minutes * 60 * 1000 + TASK_TIMEOUT_BACKSTOP_MS;
    for (const task of repo.listTasks({ state: "running" })) {
      if (!task.started_at || now - fromIso(task.started_at) <= timeoutLimit) continue;
      core.run((tx) => {
        const current = repo.getTask(task.task_id);
        if (current?.state !== "running") return;
        core.endTask(tx, current, {
          state: "failed",
          category: "timeout",
          reason: `running longer than ${settings.task_timeout_minutes} min and the runner did not stop it`,
        });
        result.timedOut.push(current.task_id);
      });
    }
    return result;
  }
}
