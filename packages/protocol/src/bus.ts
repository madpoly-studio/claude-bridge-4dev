// Task Bus contract (system design mục 7).
import type {
  FailCategory,
  Task,
  TaskPhase,
  TaskState,
  TaskUsage,
  Worker,
  WorkerFailCategory,
  WorkerState,
} from "./entities.js";

// ---------------------------------------------------------------------------
// Bus events (mục 7.7)
// ---------------------------------------------------------------------------

export const BUS_EVENT_TYPES = [
  "worker.registered",
  "worker.offline",
  "task.assigned",
  "task.started",
  "task.progress",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "ticket.created",
  "dispatch.paused",
  "dispatch.resumed",
] as const;
export type BusEventType = (typeof BUS_EVENT_TYPES)[number];

/**
 * Envelope lưu ở bảng `events` (append-only, `seq` tăng dần).
 * `session.event` KHÔNG đi qua envelope này; nó lưu bảng `session_events` riêng.
 */
export interface BusEvent<P = Record<string, unknown>> {
  seq: number;
  ts: string;
  type: BusEventType;
  worker_id: string | null;
  task_id: string | null;
  ticket_key: string | null;
  payload: P;
}

export interface TaskProgressPayload {
  phase: TaskPhase;
  message: string;
}
export interface TaskCompletedPayload {
  mr_url: string;
  branch: string;
  summary: string;
}
export interface TaskFailedPayload {
  category: FailCategory;
  reason: string;
  attempt: number;
}
export interface TaskCancelledPayload {
  reason: string;
}
export interface TicketCreatedPayload {
  session_id: string;
  labels: string[];
  has_agent_label: boolean;
}

// ---------------------------------------------------------------------------
// MCP tools (mục 7.4)
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_TOOLS = ["list_workers", "list_tasks", "assign_task", "cancel_task"] as const;
export const WORKER_TOOLS = ["report_progress", "complete_task", "fail_task"] as const;
export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOLS)[number];
export type WorkerToolName = (typeof WORKER_TOOLS)[number];

/** Tên MCP server của bus khi cấu hình cho Claude; tool đầy đủ là `mcp__bridge-bus__<tool>`. */
export const BUS_MCP_SERVER_NAME = "bridge-bus";
export function busToolFullName(tool: OrchestratorToolName | WorkerToolName): string {
  return `mcp__${BUS_MCP_SERVER_NAME}__${tool}`;
}

export interface ListWorkersInput {
  state?: WorkerState;
  repo?: string;
}
export interface ListTasksInput {
  state?: TaskState;
  ticket_key?: string;
}
export interface AssignTaskInput {
  worker_id: string;
  ticket_key: string;
  notes?: string;
}
export interface AssignTaskOutput {
  task_id: string;
}
export interface CancelTaskInput {
  task_id: string;
  reason: string;
}
export interface ReportProgressInput {
  phase: TaskPhase;
  message: string;
}
export interface CompleteTaskInput {
  mr_url: string;
  branch: string;
  summary: string;
}
export interface FailTaskInput {
  category: WorkerFailCategory;
  reason: string;
}

export const BUS_ERROR_CODES = [
  "WORKER_NOT_IDLE",
  "WORKER_NOT_FOUND",
  "TICKET_ALREADY_ACTIVE",
  "CONCURRENCY_LIMIT",
  "DISPATCH_PAUSED",
  "TASK_NOT_FOUND",
  "TASK_NOT_ACTIVE",
  "TASK_ALREADY_TERMINAL",
  "INVALID_INPUT",
  "UNAUTHORIZED",
  "FORBIDDEN",
] as const;
export type BusErrorCode = (typeof BUS_ERROR_CODES)[number];

export interface BusErrorBody {
  error: { code: BusErrorCode; message: string };
}

// ---------------------------------------------------------------------------
// Runner <-> Bus HTTP (mục 7.5). Mọi request mang `Authorization: Bearer <token>`.
// - /runners/register: token bootstrap của runner (RUNNER_BOOTSTRAP_TOKEN).
// - các endpoint còn lại: runner token nhận được khi register.
// ---------------------------------------------------------------------------

export const RUNNER_PATHS = {
  register: "/runners/register",
  next: (workerId: string) => `/runners/${encodeURIComponent(workerId)}/next`,
  heartbeat: (workerId: string) => `/runners/${encodeURIComponent(workerId)}/heartbeat`,
  started: (taskId: string) => `/tasks/${encodeURIComponent(taskId)}/started`,
  events: (taskId: string) => `/tasks/${encodeURIComponent(taskId)}/events`,
  exited: (taskId: string) => `/tasks/${encodeURIComponent(taskId)}/exited`,
} as const;

/** Endpoint MCP (streamable HTTP) của bus. Token role orchestrator hoặc task token. */
export const BUS_MCP_PATH = "/mcp";

export interface RegisterRunnerRequest {
  worker_id: string;
  repo: string;
  worktree_path: string;
  host: string;
  /** Task runner đang giữ (sau khi bus restart / runner reconnect) để bus đối chiếu. */
  current_task_id?: string | null;
}
export interface RegisterRunnerResponse {
  runner_token: string;
  worker: Worker;
  /**
   * Kết quả đối chiếu `current_task_id`:
   * - `continue`: task vẫn active ở bus, runner tiếp tục.
   * - `abort`: bus đã coi task kết thúc, runner phải kill process.
   * - `none`: không có task.
   */
  reconcile: "continue" | "abort" | "none";
  heartbeat_seconds: number;
}

/** 200 body của GET /runners/{id}/next. 204 khi không có task trong thời gian chờ. */
export interface NextTaskResponse {
  task: Task;
  /** Token MCP cho worker; chỉ tác động lên task này. */
  task_token: string;
  /** URL tuyệt đối của endpoint MCP bus. */
  mcp_url: string;
  /** Prompt giao việc đã dựng sẵn (mục 6). */
  prompt: string;
  /** Giới hạn thời gian chạy, giây. */
  timeout_seconds: number;
}

export interface HeartbeatRequest {
  current_task_id: string | null;
}
export interface HeartbeatResponse {
  cancel: boolean;
  /** Task mà lệnh cancel áp dụng (khi cancel = true). */
  task_id?: string | null;
}

export interface TaskStartedRequest {
  session_id: string | null;
  pid: number | null;
}
export interface TaskEventsRequest {
  /** Lô event stream-json thô của `claude -p`, theo thứ tự. */
  events: unknown[];
}
export interface TaskExitedRequest {
  exit_code: number | null;
  usage: TaskUsage | null;
  /** Lý do runner tự kết thúc, nếu có (ví dụ timeout, conflict, spawn_error). */
  reason?: "timeout" | "cancelled" | "conflict" | "spawn_error" | null;
  message?: string | null;
}
export interface OkResponse {
  ok: true;
}
