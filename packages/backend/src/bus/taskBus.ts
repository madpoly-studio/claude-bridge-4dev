// Nghiệp vụ Task Bus: tool orchestrator / worker (mục 7.4), dừng khẩn cấp (mục 7.9) và API cho module khác.
import {
  type AssignTaskInput,
  type AssignTaskOutput,
  type BusEvent,
  type CancelTaskInput,
  type CompleteTaskInput,
  type FailTaskInput,
  type ListTasksInput,
  type ListWorkersInput,
  type ReportProgressInput,
  type Task,
  type TaskState,
  type TicketCreatedPayload,
  type Worker,
  type WorkerState,
} from "@claude-bridge/protocol";
import { randomToken, shortId } from "../util/ids.js";
import { ListenerSet, type Unsubscribe } from "../util/listeners.js";
import type { BusCore, BusTx } from "./busCore.js";
import { BusError } from "./errors.js";
import { hashToken } from "./tokens.js";

const DISPATCH_PAUSED_KEY = "dispatch_paused";
/** Khóa ticket Jira đầy đủ, ví dụ `SH-129`. */
const TICKET_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
/** Số task đã kết thúc đưa vào state.snapshot (task active luôn có đủ). */
const DEFAULT_RECENT_TASKS = 500;

export interface BusStatus {
  workers: Record<WorkerState, number>;
  tasks: Record<TaskState, number>;
  /** assigned + running — con số được so với max_concurrency. */
  active: number;
  max_concurrency: number;
  dispatch_paused: boolean;
}

export interface TicketCreatedInput {
  ticket_key: string;
  session_id: string;
  labels: string[];
}

export class TaskBus {
  /**
   * Task token dạng rõ, giữ trong bộ nhớ từ lúc assign đến lúc task kết thúc để `next` trả lại được.
   * DB chỉ lưu hash; sau restart token được cấp lại khi runner nhận task (xem `tokenForDelivery`).
   */
  private readonly plainTaskTokens = new Map<string, string>();
  private readonly assignedListeners = new ListenerSet<Task>("bus.assigned");

  constructor(private readonly core: BusCore) {
    core.onTaskUpdated((task) => {
      if (!core.isActive(task)) this.plainTaskTokens.delete(task.task_id);
    });
  }

  /** Gọi sau khi assign commit; RunnerService dùng để đánh thức long-poll. */
  onTaskAssigned(cb: (task: Task) => void): Unsubscribe {
    return this.assignedListeners.add(cb);
  }

  // ---- orchestrator tools --------------------------------------------------

  listWorkers(input: ListWorkersInput = {}): Worker[] {
    return this.core.repo.listWorkers(input);
  }

  listTasks(input: ListTasksInput = {}): Task[] {
    return this.core.repo.listTasks(input);
  }

  /** Cho state.snapshot: mọi task active + các task kết thúc gần nhất. */
  listRecentTasks(limit = DEFAULT_RECENT_TASKS): Task[] {
    return this.core.repo.listRecentTasks(limit);
  }

  getTask(taskId: string): Task | null {
    return this.core.repo.getTask(taskId);
  }

  /** Bất biến 1–4: kiểm tra và ghi trong cùng một transaction; unique index một phần là backstop. */
  assignTask(input: AssignTaskInput): AssignTaskOutput {
    if (!TICKET_KEY_RE.test(input.ticket_key)) {
      throw new BusError("INVALID_INPUT", `ticket_key "${input.ticket_key}" is not a Jira issue key (e.g. SH-129)`);
    }
    const { repo, settings } = this.core;
    const token = randomToken();
    const task = this.core.run((tx) => {
      if (this.isDispatchPaused()) throw new BusError("DISPATCH_PAUSED", "dispatch is paused by the user");
      const worker = repo.getWorker(input.worker_id);
      if (!worker) throw new BusError("WORKER_NOT_FOUND", `worker ${input.worker_id} not found`);
      if (worker.state !== "idle" || repo.getActiveTaskForWorker(worker.worker_id)) {
        throw new BusError("WORKER_NOT_IDLE", `worker ${worker.worker_id} is ${worker.state}`);
      }
      const existing = repo.getActiveTaskForTicket(input.ticket_key);
      if (existing) {
        throw new BusError("TICKET_ALREADY_ACTIVE", `ticket ${input.ticket_key} already has active task ${existing.task_id}`);
      }
      // Đếm cả `assigned` (sắp thành running) để bất biến 3 không bị vượt khi các runner cùng bắt đầu.
      const active = repo.countActiveTasks();
      if (active >= settings.max_concurrency) {
        throw new BusError("CONCURRENCY_LIMIT", `${active} active task(s), max_concurrency is ${settings.max_concurrency}`);
      }
      const taskId = shortId("t");
      const attempt = 1 + repo.countTasksForTicket(input.ticket_key);
      try {
        repo.insertTask({
          task_id: taskId,
          ticket_key: input.ticket_key,
          worker_id: worker.worker_id,
          attempt,
          notes: input.notes ?? null,
          token_hash: hashToken(token),
          assigned_at: this.core.nowIso(),
        });
      } catch (err) {
        throw mapUniqueViolation(err);
      }
      repo.updateWorker(worker.worker_id, { state: "busy", current_task_id: taskId });
      tx.workers.add(worker.worker_id);
      tx.tasks.add(taskId);
      tx.statusChanged = true;
      this.core.emit(tx, {
        type: "task.assigned",
        worker_id: worker.worker_id,
        task_id: taskId,
        ticket_key: input.ticket_key,
        payload: { attempt, notes: input.notes ?? null },
      });
      return this.core.requireTask(taskId);
    });
    this.plainTaskTokens.set(task.task_id, token);
    this.assignedListeners.emit(task);
    return { task_id: task.task_id };
  }

  cancelTask(input: CancelTaskInput): Task {
    return this.core.run((tx) => {
      const task = this.core.requireTask(input.task_id);
      if (!this.core.isActive(task)) {
        throw new BusError("TASK_ALREADY_TERMINAL", `task ${task.task_id} is already ${task.state}`);
      }
      // Runner nhận cờ cancel qua heartbeat (task ở state cancelled) và kill process.
      return this.core.endTask(tx, task, { state: "cancelled", reason: input.reason });
    });
  }

  // ---- worker tools (taskId lấy từ task token, không từ input) ---------------

  reportProgress(taskId: string, input: ReportProgressInput): void {
    this.core.run((tx) => {
      const task = this.requireRunningForWorkerTool(tx, taskId);
      this.core.repo.updateTask(task.task_id, { phase: input.phase }, ["running"]);
      tx.tasks.add(task.task_id);
      this.core.emit(tx, {
        type: "task.progress",
        worker_id: task.worker_id,
        task_id: task.task_id,
        ticket_key: task.ticket_key,
        payload: { phase: input.phase, message: input.message },
      });
    });
  }

  completeTask(taskId: string, input: CompleteTaskInput): void {
    this.core.run((tx) => {
      const task = this.requireRunningForWorkerTool(tx, taskId);
      this.core.endTask(tx, task, { state: "completed", mr_url: input.mr_url, branch: input.branch, summary: input.summary });
    });
  }

  failTask(taskId: string, input: FailTaskInput): void {
    this.core.run((tx) => {
      const task = this.requireRunningForWorkerTool(tx, taskId);
      this.core.endTask(tx, task, { state: "failed", category: input.category, reason: input.reason });
    });
  }

  /**
   * Worker gọi tool nghĩa là process đã chạy: task `assigned` được coi như `running`
   * (runner có thể chưa kịp gọi /started), giữ đúng state machine assigned → running → kết thúc.
   */
  private requireRunningForWorkerTool(tx: BusTx, taskId: string): Task {
    const task = this.core.requireTask(taskId);
    if (!this.core.isActive(task)) throw new BusError("TASK_NOT_ACTIVE", `task ${taskId} is ${task.state}`);
    if (task.state === "assigned") return this.core.startTask(tx, task, { session_id: null, pid: null, implied: true });
    return task;
  }

  // ---- task token -----------------------------------------------------------

  /** Task id của một task token (kể cả task đã kết thúc), null nếu không khớp. */
  resolveTaskToken(token: string): string | null {
    return this.core.repo.getTaskByTokenHash(hashToken(token))?.task_id ?? null;
  }

  /** Token đưa cho runner khi giao task; cấp lại nếu bản rõ đã mất do bus restart. */
  tokenForDelivery(task: Task): string {
    const existing = this.plainTaskTokens.get(task.task_id);
    if (existing) return existing;
    const token = randomToken();
    this.core.repo.updateTask(task.task_id, { token_hash: hashToken(token) }, ["assigned", "running"]);
    this.plainTaskTokens.set(task.task_id, token);
    return token;
  }

  // ---- dispatch pause (mục 7.9) ----------------------------------------------

  isDispatchPaused(): boolean {
    return this.core.repo.getSetting(DISPATCH_PAUSED_KEY) === "true";
  }

  /** Bật / tắt cờ dừng giao việc. Task đang chạy không bị ảnh hưởng. Trả về true nếu có thay đổi. */
  setDispatchPaused(paused: boolean): boolean {
    return this.core.run((tx) => {
      if (this.isDispatchPaused() === paused) return false;
      this.core.repo.setSetting(DISPATCH_PAUSED_KEY, paused ? "true" : "false");
      this.core.markStatusChanged(tx);
      this.core.emit(tx, { type: paused ? "dispatch.paused" : "dispatch.resumed" });
      return true;
    });
  }

  // ---- API cho module khác -----------------------------------------------------

  /** Permission Broker gọi khi planner tạo ticket thành công (mục 5.3 bước 5). Bus không ghi Jira. */
  emitTicketCreated(input: TicketCreatedInput): BusEvent<TicketCreatedPayload> {
    if (!TICKET_KEY_RE.test(input.ticket_key)) {
      throw new BusError("INVALID_INPUT", `ticket_key "${input.ticket_key}" is not a Jira issue key`);
    }
    const payload: TicketCreatedPayload = {
      session_id: input.session_id,
      labels: [...input.labels],
      has_agent_label: input.labels.includes(this.core.settings.agent_label),
    };
    const event = this.core.run((tx) => this.core.emit(tx, { type: "ticket.created", ticket_key: input.ticket_key, payload }));
    return { ...event, payload };
  }

  status(): BusStatus {
    const tasks = this.core.repo.countTasksByState();
    return {
      workers: this.core.repo.countWorkersByState(),
      tasks,
      active: tasks.assigned + tasks.running,
      max_concurrency: this.core.settings.max_concurrency,
      dispatch_paused: this.isDispatchPaused(),
    };
  }
}

function mapUniqueViolation(err: unknown): unknown {
  const e = err as { code?: string; message?: string };
  if (e.code === "SQLITE_CONSTRAINT_UNIQUE" && typeof e.message === "string") {
    if (e.message.includes("tasks.ticket_key")) return new BusError("TICKET_ALREADY_ACTIVE", "ticket already has an active task");
    if (e.message.includes("tasks.worker_id")) return new BusError("WORKER_NOT_IDLE", "worker already has an active task");
  }
  return err;
}
