// Lõi Task Bus: transaction + các chuyển trạng thái dùng chung (system design mục 7.2, 7.3).
// TaskBus (tool MCP), RunnerService (HTTP runner) và Sweeper (mục 7.8) đều đi qua đây.
import {
  type BusEvent,
  type FailCategory,
  type Task,
  type TaskState,
  type Worker,
  ACTIVE_TASK_STATES,
} from "@claude-bridge/protocol";
import type { Db } from "../db/database.js";
import type { BusEventInput, EventLog } from "../events/eventLog.js";
import { type Clock, toIso } from "../util/clock.js";
import { ListenerSet, type Unsubscribe } from "../util/listeners.js";
import { BusError } from "./errors.js";
import { type BusRepository, toWorker } from "./repository.js";

/** Phần cấu hình bus cần. Đọc động để test đổi được. */
export interface BusSettings {
  max_concurrency: number;
  task_timeout_minutes: number;
  heartbeat_seconds: number;
  heartbeat_lost_seconds: number;
  assign_start_timeout_seconds: number;
  agent_label: string;
}

/** Ghi nhận thay đổi trong một transaction; chỉ thông báo ra ngoài sau khi commit. */
export class BusTx {
  readonly events: BusEvent[] = [];
  readonly workers = new Set<string>();
  readonly tasks = new Set<string>();
  statusChanged = false;
}

export type TerminalOutcome =
  | { state: "completed"; mr_url: string; branch: string; summary: string }
  | { state: "failed"; category: FailCategory; reason: string }
  | { state: "cancelled"; reason: string };

export type OfflineReason = "heartbeat_lost" | "runner_unresponsive";

const ACTIVE = ACTIVE_TASK_STATES as readonly TaskState[];

export class BusCore {
  private readonly workerListeners = new ListenerSet<Worker>("bus.worker");
  private readonly taskListeners = new ListenerSet<Task>("bus.task");
  private readonly statusListeners = new ListenerSet<void>("bus.status");
  /** Mốc khởi động bus; dùng làm ân hạn cho timeout sau restart (runner cần thời gian đăng ký lại). */
  readonly startedAt: number;

  constructor(
    readonly db: Db,
    readonly repo: BusRepository,
    readonly eventLog: EventLog,
    readonly clock: Clock,
    readonly settings: BusSettings,
  ) {
    this.startedAt = clock.now();
  }

  nowIso(): string {
    return toIso(this.clock.now());
  }

  onWorkerUpdated(cb: (worker: Worker) => void): Unsubscribe {
    return this.workerListeners.add(cb);
  }

  onTaskUpdated(cb: (task: Task) => void): Unsubscribe {
    return this.taskListeners.add(cb);
  }

  /** Số task active / dispatch_paused có thể đã đổi. */
  onStatusChanged(cb: () => void): Unsubscribe {
    return this.statusListeners.add(cb);
  }

  /**
   * Chạy `fn` trong một transaction SQLite. Nếu `fn` throw, mọi ghi bị rollback và không có thông báo nào.
   * Sau commit: phát worker/task updated (đọc lại bản mới), bus event, rồi status.
   */
  run<T>(fn: (tx: BusTx) => T): T {
    const tx = new BusTx();
    const result = this.db.transaction(() => fn(tx))();
    for (const id of tx.workers) {
      const w = this.repo.getWorker(id);
      if (w) this.workerListeners.emit(toWorker(w));
    }
    for (const id of tx.tasks) {
      const t = this.repo.getTask(id);
      if (t) this.taskListeners.emit(t);
    }
    for (const event of tx.events) this.eventLog.publishBusEvent(event);
    if (tx.statusChanged) this.statusListeners.emit();
    return result;
  }

  emit(tx: BusTx, input: BusEventInput): BusEvent {
    const event = this.eventLog.insertBusEvent(input);
    tx.events.push(event);
    return event;
  }

  /** Báo thay đổi status không đi kèm task/worker (ví dụ dispatch_paused). */
  markStatusChanged(tx: BusTx): void {
    tx.statusChanged = true;
  }

  requireTask(taskId: string): Task {
    const task = this.repo.getTask(taskId);
    if (!task) throw new BusError("TASK_NOT_FOUND", `task ${taskId} not found`);
    return task;
  }

  isActive(task: Task): boolean {
    return ACTIVE.includes(task.state);
  }

  /** assigned → running. Không làm gì nếu đã running. */
  startTask(tx: BusTx, task: Task, info: { session_id: string | null; pid: number | null; implied?: boolean }): Task {
    if (task.state === "running") {
      if (task.session_id === null && info.session_id !== null) {
        this.repo.updateTask(task.task_id, { session_id: info.session_id });
        tx.tasks.add(task.task_id);
      }
      return this.requireTask(task.task_id);
    }
    if (task.state !== "assigned") {
      throw new BusError("TASK_NOT_ACTIVE", `task ${task.task_id} is ${task.state}`);
    }
    const ok = this.repo.updateTask(
      task.task_id,
      { state: "running", started_at: this.nowIso(), session_id: info.session_id ?? task.session_id, pid: info.pid },
      ["assigned"],
    );
    if (!ok) throw new BusError("TASK_NOT_ACTIVE", `task ${task.task_id} changed state concurrently`);
    tx.tasks.add(task.task_id);
    tx.statusChanged = true;
    const payload: Record<string, unknown> = { session_id: info.session_id, pid: info.pid };
    if (info.implied) payload.implied = true;
    this.emit(tx, { type: "task.started", worker_id: task.worker_id, task_id: task.task_id, ticket_key: task.ticket_key, payload });
    return this.requireTask(task.task_id);
  }

  /**
   * Đưa task active vào state kết thúc (bất biến 5: chỉ từ assigned/running), phát event,
   * và trả worker về idle nếu worker vẫn đang giữ task này.
   */
  endTask(tx: BusTx, task: Task, outcome: TerminalOutcome): Task {
    if (!this.isActive(task)) {
      throw new BusError("TASK_NOT_ACTIVE", `task ${task.task_id} is already ${task.state}`);
    }
    const ended_at = this.nowIso();
    const patch =
      outcome.state === "completed"
        ? { state: outcome.state, mr_url: outcome.mr_url, branch: outcome.branch, summary: outcome.summary, ended_at }
        : outcome.state === "failed"
          ? { state: outcome.state, fail_category: outcome.category, fail_reason: outcome.reason, ended_at }
          : { state: outcome.state, fail_reason: outcome.reason, ended_at };
    if (!this.repo.updateTask(task.task_id, patch, ACTIVE)) {
      throw new BusError("TASK_NOT_ACTIVE", `task ${task.task_id} changed state concurrently`);
    }
    tx.tasks.add(task.task_id);
    tx.statusChanged = true;

    const worker = this.repo.getWorker(task.worker_id);
    if (worker && worker.current_task_id === task.task_id) {
      this.repo.updateWorker(worker.worker_id, {
        current_task_id: null,
        state: worker.state === "offline" ? "offline" : "idle",
      });
      tx.workers.add(worker.worker_id);
    }

    const ids = { worker_id: task.worker_id, task_id: task.task_id, ticket_key: task.ticket_key };
    if (outcome.state === "completed") {
      this.emit(tx, { type: "task.completed", ...ids, payload: { mr_url: outcome.mr_url, branch: outcome.branch, summary: outcome.summary } });
    } else if (outcome.state === "failed") {
      this.emit(tx, { type: "task.failed", ...ids, payload: { category: outcome.category, reason: outcome.reason, attempt: task.attempt } });
    } else {
      this.emit(tx, { type: "task.cancelled", ...ids, payload: { reason: outcome.reason } });
    }
    return this.requireTask(task.task_id);
  }

  /** Worker → offline; mọi task active của nó → failed(`category`). */
  markWorkerOffline(tx: BusTx, workerId: string, reason: OfflineReason, category: FailCategory, detail: string): void {
    const active = this.repo.getActiveTaskForWorker(workerId);
    if (active) this.endTask(tx, active, { state: "failed", category, reason: detail });
    this.repo.updateWorker(workerId, { state: "offline", current_task_id: null });
    tx.workers.add(workerId);
    this.emit(tx, { type: "worker.offline", worker_id: workerId, payload: { reason } });
  }
}
