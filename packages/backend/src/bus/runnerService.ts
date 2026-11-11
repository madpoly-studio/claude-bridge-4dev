// Runner ↔ Bus (mục 7.5): đăng ký, long-poll nhận task, heartbeat, vòng đời process.
// Runner là nguồn sự thật về vòng đời process; tool của worker là nguồn sự thật về kết quả (mục 3.1).
import {
  type HeartbeatRequest,
  type HeartbeatResponse,
  type NextTaskResponse,
  type RegisterRunnerRequest,
  type RegisterRunnerResponse,
  type SystemFailCategory,
  type Task,
  type TaskEventsRequest,
  type TaskExitedRequest,
  type TaskStartedRequest,
  SYSTEM_FAIL_CATEGORIES,
  buildWorkerPrompt,
} from "@claude-bridge/protocol";
import { randomToken } from "../util/ids.js";
import type { BusCore, BusTx, TerminalOutcome } from "./busCore.js";
import { BusError } from "./errors.js";
import { toWorker } from "./repository.js";
import type { TaskBus } from "./taskBus.js";
import { hashToken, safeEqualHash } from "./tokens.js";
import type { TaskWaiters } from "./waiters.js";

const SYSTEM_FAIL = SYSTEM_FAIL_CATEGORIES as readonly string[];

export class RunnerService {
  private closed = false;

  constructor(
    private readonly core: BusCore,
    private readonly bus: TaskBus,
    private readonly waiters: TaskWaiters,
    /** URL tuyệt đối của endpoint MCP; chỉ biết sau khi server listen (port 0 trong test). */
    private readonly mcpUrl: () => string,
  ) {
    bus.onTaskAssigned((task) => waiters.notify(task.worker_id));
  }

  /** Trả mọi long-poll đang chờ (204) khi tắt server; DB phải còn mở lúc gọi. */
  close(): void {
    this.closed = true;
    this.waiters.releaseAll();
  }

  // ---- xác thực -------------------------------------------------------------

  /** Runner token phải thuộc đúng worker trong URL. */
  authorizeWorker(token: string | null, workerId: string): void {
    if (!token) throw new BusError("UNAUTHORIZED", "missing bearer token");
    const worker = this.core.repo.getWorker(workerId);
    // Runner đăng ký lại khi nhận 401 hoặc 404 WORKER_NOT_FOUND (ví dụ DB của bus bị xóa).
    if (!worker) throw new BusError("WORKER_NOT_FOUND", `worker ${workerId} is not registered`);
    if (!worker.runner_token_hash || !safeEqualHash(token, worker.runner_token_hash)) {
      throw new BusError("UNAUTHORIZED", "invalid runner token");
    }
  }

  /** Runner token phải thuộc worker đang giữ task. */
  authorizeTask(token: string | null, taskId: string): Task {
    if (!token) throw new BusError("UNAUTHORIZED", "missing bearer token");
    const worker = this.core.repo.getWorkerByTokenHash(hashToken(token));
    if (!worker) throw new BusError("UNAUTHORIZED", "invalid runner token");
    const task = this.core.requireTask(taskId);
    if (task.worker_id !== worker.worker_id) {
      throw new BusError("FORBIDDEN", `task ${taskId} does not belong to worker ${worker.worker_id}`);
    }
    return task;
  }

  // ---- register ---------------------------------------------------------------

  /** Idempotent theo worker_id; cấp runner token mới mỗi lần và đối chiếu `current_task_id`. */
  register(req: RegisterRunnerRequest): RegisterRunnerResponse {
    const runnerToken = randomToken();
    const { repo } = this.core;
    return this.core.run((tx) => {
      const now = this.core.nowIso();
      const existing = repo.getWorker(req.worker_id);
      const announce = !existing || existing.state === "offline";
      const identity = { repo: req.repo, worktree_path: req.worktree_path, host: req.host };
      if (!existing) {
        repo.insertWorker({
          worker_id: req.worker_id,
          ...identity,
          state: "idle",
          last_heartbeat: now,
          runner_token_hash: hashToken(runnerToken),
          registered_at: now,
        });
      } else {
        repo.updateWorker(req.worker_id, { ...identity, last_heartbeat: now, runner_token_hash: hashToken(runnerToken) });
      }

      const active = repo.getActiveTaskForWorker(req.worker_id);
      let reconcile: RegisterRunnerResponse["reconcile"] = "none";
      if (req.current_task_id) {
        reconcile = active && active.task_id === req.current_task_id ? "continue" : "abort";
      }
      // Runner không còn giữ task đang running → process đã mất cùng runner cũ.
      if (active && active.state === "running" && reconcile !== "continue") {
        this.core.endTask(tx, active, { state: "failed", category: "runner_lost", reason: "runner re-registered without the running task" });
      }
      const stillActive = repo.getActiveTaskForWorker(req.worker_id);
      repo.updateWorker(req.worker_id, { state: stillActive ? "busy" : "idle", current_task_id: stillActive?.task_id ?? null });
      tx.workers.add(req.worker_id);
      tx.statusChanged = true;
      if (announce) this.core.emit(tx, { type: "worker.registered", worker_id: req.worker_id, payload: identity });

      const worker = repo.getWorker(req.worker_id);
      if (!worker) throw new Error(`worker ${req.worker_id} vanished during register`);
      return {
        runner_token: runnerToken,
        worker: toWorker(worker),
        reconcile,
        heartbeat_seconds: this.core.settings.heartbeat_seconds,
      };
    });
  }

  // ---- liveness ---------------------------------------------------------------

  /** Cập nhật last_heartbeat; worker đang offline mà còn liên lạc → idle + worker.registered. */
  private markAlive(workerId: string): void {
    this.core.run((tx) => this.markAliveTx(tx, workerId));
  }

  private markAliveTx(tx: BusTx, workerId: string): void {
    const worker = this.core.repo.getWorker(workerId);
    if (!worker) throw new BusError("WORKER_NOT_FOUND", `worker ${workerId} not found`);
    if (worker.state === "offline") {
      this.core.repo.updateWorker(workerId, { last_heartbeat: this.core.nowIso(), state: "idle", current_task_id: null });
      tx.workers.add(workerId);
      tx.statusChanged = true;
      this.core.emit(tx, {
        type: "worker.registered",
        worker_id: workerId,
        payload: { repo: worker.repo, worktree_path: worker.worktree_path, host: worker.host, resumed: true },
      });
    } else {
      this.core.repo.updateWorker(workerId, { last_heartbeat: this.core.nowIso() });
    }
  }

  /** Long-poll: trả task `assigned` của worker, hoặc null (→ 204) khi hết `waitSeconds`. */
  async next(workerId: string, waitSeconds: number, signal?: AbortSignal): Promise<NextTaskResponse | null> {
    this.markAlive(workerId);
    // Thời gian chờ là thời gian thật (không theo clock tiêm vào): đây là I/O, không phải luật timeout của bus.
    const deadline = Date.now() + waitSeconds * 1000;
    try {
      for (;;) {
        const task = this.core.repo.getActiveTaskForWorker(workerId);
        if (task && task.state === "assigned") return this.deliver(task);
        const remaining = deadline - Date.now();
        if (remaining <= 0 || signal?.aborted || this.closed) return null;
        await this.waiters.wait(workerId, remaining, signal);
      }
    } finally {
      // Long-poll đang chờ cũng là dấu hiệu sống (runner idle có thể không gửi heartbeat).
      if (!signal?.aborted && !this.closed) this.markAlive(workerId);
    }
  }

  private deliver(task: Task): NextTaskResponse {
    return {
      task,
      task_token: this.bus.tokenForDelivery(task),
      mcp_url: this.mcpUrl(),
      prompt: buildWorkerPrompt({ ticket_key: task.ticket_key, task_id: task.task_id, notes: task.notes }),
      timeout_seconds: this.core.settings.task_timeout_minutes * 60,
    };
  }

  /** `cancel: true` khi task runner đang giữ đã bị hủy / bus đánh fail, để runner kill process. */
  heartbeat(workerId: string, req: HeartbeatRequest): HeartbeatResponse {
    this.markAlive(workerId);
    const taskId = req.current_task_id;
    if (!taskId) return { cancel: false };
    const task = this.core.repo.getTask(taskId);
    if (!task || task.worker_id !== workerId) return { cancel: true, task_id: taskId };
    const killedByBus =
      task.state === "cancelled" || (task.state === "failed" && task.fail_category !== null && SYSTEM_FAIL.includes(task.fail_category));
    return killedByBus ? { cancel: true, task_id: taskId } : { cancel: false };
  }

  // ---- vòng đời process ---------------------------------------------------------

  started(task: Task, req: TaskStartedRequest): Task {
    return this.core.run((tx) => {
      this.markAliveTx(tx, task.worker_id);
      const current = this.core.requireTask(task.task_id);
      return this.core.startTask(tx, current, { session_id: req.session_id, pid: req.pid });
    });
  }

  /** Ghi lô stream-json vào session_events; điền session_id của task từ event init nếu chưa có. */
  events(task: Task, req: TaskEventsRequest): { appended: number } {
    let sessionId = task.session_id;
    if (sessionId === null) {
      const initId = findInitSessionId(req.events);
      if (initId !== null) {
        this.core.run((tx) => {
          if (this.core.repo.updateTask(task.task_id, { session_id: initId })) tx.tasks.add(task.task_id);
        });
        sessionId = initId;
      }
    }
    const key = sessionId ?? `task:${task.task_id}`;
    const records = this.core.eventLog.appendSessionEvents(
      req.events.map((event) => ({ session_id: key, task_id: task.task_id, origin: "agent" as const, event })),
    );
    return { appended: records.length };
  }

  exited(task: Task, req: TaskExitedRequest): Task {
    return this.core.run((tx) => {
      const current = this.core.requireTask(task.task_id);
      if (req.usage) {
        this.core.repo.updateTask(current.task_id, { usage: req.usage });
        tx.tasks.add(current.task_id);
      }
      if (this.core.isActive(current)) {
        this.core.endTask(tx, current, outcomeForExit(req));
      }
      // Task đã kết thúc trước (complete/fail/cancel): worker đã được trả idle ở endTask.
      return this.core.requireTask(current.task_id);
    });
  }
}

function outcomeForExit(req: TaskExitedRequest): TerminalOutcome {
  const detail = req.message ?? null;
  const failed = (category: SystemFailCategory | "conflict" | "other", reason: string): TerminalOutcome => ({
    state: "failed",
    category,
    reason,
  });
  switch (req.reason) {
    case "timeout":
      return failed("timeout", detail ?? "runner killed the process after TASK_TIMEOUT");
    case "conflict":
      return failed("conflict", detail ?? "worktree is dirty; worker was not spawned");
    case "spawn_error":
      return failed("other", detail ?? "runner could not spawn the worker process");
    case "cancelled":
      return { state: "cancelled", reason: detail ?? "runner cancelled the process" };
    default:
      return failed("no_terminal_report", detail ?? `process exited (code ${req.exit_code ?? "null"}) without complete_task or fail_task`);
  }
}

/** Lấy session_id từ event `{type:"system", subtype:"init", session_id}` của stream-json. */
function findInitSessionId(events: readonly unknown[]): string | null {
  for (const e of events) {
    if (typeof e !== "object" || e === null) continue;
    const rec = e as Record<string, unknown>;
    if (rec.type === "system" && rec.subtype === "init" && typeof rec.session_id === "string" && rec.session_id.length > 0) {
      return rec.session_id;
    }
  }
  return null;
}
