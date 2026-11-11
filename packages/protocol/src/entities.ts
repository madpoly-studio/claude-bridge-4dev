// Thực thể dùng chung (system design mục 7.1, 11).
// Mọi timestamp là chuỗi ISO-8601 UTC.

export type WorkerState = "offline" | "idle" | "busy";

export type TaskState = "assigned" | "running" | "completed" | "failed" | "cancelled";

export const ACTIVE_TASK_STATES = ["assigned", "running"] as const satisfies readonly TaskState[];
export const TERMINAL_TASK_STATES = ["completed", "failed", "cancelled"] as const satisfies readonly TaskState[];

export function isTerminalTaskState(state: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly TaskState[]).includes(state);
}

/** Phase do worker báo qua `report_progress` (mục 7.4). Thứ tự = thứ tự thanh 5 phase trên UI. */
export const TASK_PHASES = ["understanding", "implementing", "testing", "pushing", "mr_created"] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

/** Category worker được phép dùng trong `fail_task`. */
export const WORKER_FAIL_CATEGORIES = ["blocked", "unclear_requirement", "build_failed", "conflict", "other"] as const;
export type WorkerFailCategory = (typeof WORKER_FAIL_CATEGORIES)[number];

/** Category do bus / runner tự xác định (mục 7.8). */
export const SYSTEM_FAIL_CATEGORIES = [
  "runner_unresponsive",
  "runner_lost",
  "timeout",
  "no_terminal_report",
] as const;
export type SystemFailCategory = (typeof SYSTEM_FAIL_CATEGORIES)[number];

export type FailCategory = WorkerFailCategory | SystemFailCategory;

export interface Worker {
  worker_id: string;
  repo: string;
  worktree_path: string;
  host: string;
  state: WorkerState;
  current_task_id: string | null;
  last_heartbeat: string | null;
}

export interface Task {
  task_id: string;
  ticket_key: string;
  worker_id: string;
  state: TaskState;
  attempt: number;
  session_id: string | null;
  /** Phase gần nhất worker báo; null khi chưa báo. */
  phase: TaskPhase | null;
  branch: string | null;
  mr_url: string | null;
  summary: string | null;
  fail_category: FailCategory | null;
  fail_reason: string | null;
  notes: string | null;
  usage: TaskUsage | null;
  assigned_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface TaskUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_cost_usd?: number;
  [k: string]: unknown;
}

export type SessionRole = "planner" | "orchestrator";

/**
 * - `starting`: đã tạo, chưa nhận session_id từ event init.
 * - `active`: process/query đang sống.
 * - `detached`: backend restart, chờ resume (mục 5.2).
 * - `closed`: người dùng đóng.
 * - `error`: lỗi không tự phục hồi được.
 */
export type SessionState = "starting" | "active" | "detached" | "closed" | "error";

export interface Session {
  /** ID nội bộ của bridge, ổn định từ lúc tạo (trước khi có session_id của Claude). */
  session_id: string;
  /** session_id của Claude, lấy từ event init; dùng để resume. */
  claude_session_id: string | null;
  role: SessionRole;
  /** Jira project key (orchestrator: bắt buộc; planner: project mặc định của repo nếu có). */
  project_key: string | null;
  repo: string | null;
  title: string | null;
  state: SessionState;
  /** true khi đang giữa một turn. */
  busy: boolean;
  created_at: string;
  last_active_at: string;
}

export type PermissionDecision = "allow" | "deny";

export interface PermissionRequest {
  request_id: string;
  session_id: string;
  tool: string;
  input: Record<string, unknown>;
  decision: PermissionDecision | null;
  /** Input đã sửa nếu người dùng chọn Sửa. */
  updated_input: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
}

/** Ticket Jira cho tab Tickets (Jira Reader, mục 5.4). Chỉ đọc. */
export interface Ticket {
  key: string;
  summary: string;
  issue_type: string;
  status: string;
  status_category: "new" | "indeterminate" | "done" | string;
  labels: string[];
  url: string;
  /** Các ticket đang chặn ticket này (link "is blocked by") chưa done. */
  blocked_by: string[];
  updated: string | null;
}

export type OrchestratorHealth = "alive" | "restarting" | "dead" | "stopped";

export interface SystemStatus {
  backend: "ok";
  project_key: string | null;
  orchestrator: OrchestratorHealth;
  dispatch_paused: boolean;
  running: number;
  max_concurrency: number;
  /** Ẩn khi không có nguồn dữ liệu (mục 10.4). */
  seat_usage?: SeatUsage;
  /** Có khi gặp lỗi rate limit gần nhất. */
  rate_limited_until?: string | null;
  jira: "ok" | "unconfigured" | "error";
}

export interface SeatUsage {
  status: string;
  resets_at?: string | null;
  utilization?: number | null;
}
