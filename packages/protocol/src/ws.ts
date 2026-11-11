// Giao thức WebSocket frontend <-> backend (system design mục 9).
// Độc lập transport: mọi message là JSON envelope, không phụ thuộc đặc tính của ws.
import type { BusEvent } from "./bus.js";
import type {
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionRole,
  SystemStatus,
  Task,
  Ticket,
  Worker,
} from "./entities.js";

export interface Envelope<T extends string = string, P = unknown> {
  id: string;
  type: T;
  payload: P;
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export interface ClientPayloads {
  auth: { token: string };
  subscribe: { since_seq?: number };
  "project.select": { project_key: string };
  "session.create": { role: "planner"; repo: string; title?: string };
  "session.list": { role: SessionRole };
  "session.open": { session_id: string; since?: number };
  "session.send": { session_id: string; text: string };
  "session.interrupt": { session_id: string };
  "session.close": { session_id: string };
  "permission.respond": {
    request_id: string;
    decision: PermissionDecision;
    updated_input?: Record<string, unknown>;
    reason?: string;
  };
  "dispatch.pause": Record<string, never>;
  "dispatch.resume": Record<string, never>;
  "task.open": { task_id: string; since?: number };
  "tickets.refresh": Record<string, never>;
}
export type ClientMessageType = keyof ClientPayloads;
export type ClientMessage = {
  [K in ClientMessageType]: Envelope<K, ClientPayloads[K]>;
}[ClientMessageType];

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type SessionEventOrigin = "user" | "agent" | "system";

/** Một dòng của luồng session (planner, orchestrator, hoặc worker qua task). */
export interface SessionEventRecord {
  /** id tăng dần trong bảng session_events; dùng làm `since` khi mở lại. */
  id: number;
  session_id: string;
  task_id: string | null;
  ts: string;
  origin: SessionEventOrigin;
  /** Message SDK / stream-json thô, hoặc `{type:"user_text", text}` cho turn của người dùng/hệ thống. */
  event: unknown;
}

export interface ServerPayloads {
  ack: { result?: unknown };
  error: { code: string; message: string };
  "auth.ok": { server_version: string; projects: string[]; repos: RepoOption[] };
  "state.snapshot": {
    workers: Worker[];
    tasks: Task[];
    tickets: Ticket[];
    sessions: Session[];
    pending_permissions: PermissionRequest[];
    status: SystemStatus;
    last_seq: number;
  };
  "bus.event": BusEvent;
  /** Kết thúc replay sau subscribe. */
  "replay.done": { last_seq: number };
  "session.event": SessionEventRecord;
  /**
   * Gửi sau session.open / task.open: lịch sử trong một lô — các event MỚI NHẤT có id > since (tối đa giới hạn của
   * backend), tăng dần theo id.
   */
  "session.history": {
    session_id: string | null;
    task_id: string | null;
    events: SessionEventRecord[];
    /** true khi còn event cũ hơn (id > since) không được gửi vì vượt giới hạn: UI nên báo có khoảng trống. */
    truncated?: boolean;
    /** id của event đầu tiên (cũ nhất) trong `events`; null khi `events` rỗng. */
    first_id?: number | null;
  };
  "session.updated": Session;
  "worker.updated": Worker;
  "task.updated": Task;
  "permission.request": PermissionRequest;
  "permission.resolved": PermissionRequest;
  "tickets.updated": { tickets: Ticket[] };
  "system.status": SystemStatus;
}
export type ServerMessageType = keyof ServerPayloads;
export type ServerMessage = {
  [K in ServerMessageType]: Envelope<K, ServerPayloads[K]>;
}[ServerMessageType];

export interface RepoOption {
  /** Tên hiển thị / khóa trong REPO_WHITELIST. */
  name: string;
  path: string;
  project_key: string | null;
}

export const WS_ERROR_CODES = [
  "UNAUTHENTICATED",
  "BAD_REQUEST",
  "NOT_FOUND",
  "FORBIDDEN",
  "CONFLICT",
  "INTERNAL",
] as const;
export type WsErrorCode = (typeof WS_ERROR_CODES)[number] | string;

/** Mã đóng WebSocket. */
export const WS_CLOSE = {
  ORIGIN_REJECTED: 4401,
  AUTH_FAILED: 4403,
  AUTH_TIMEOUT: 4408,
} as const;
