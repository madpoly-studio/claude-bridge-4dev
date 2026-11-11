import type {
  BusEvent,
  PermissionRequest,
  RepoOption,
  ServerMessage,
  Session,
  SessionEventRecord,
  SystemStatus,
  Task,
  Ticket,
  Worker,
} from "@claude-bridge/protocol";
import type { ConnectionState } from "../ws/client";

export interface StreamState {
  /** Sắp xếp tăng dần theo id, không trùng id. */
  records: SessionEventRecord[];
  lastId: number;
  /** Đã nhận session.history ít nhất một lần. */
  loaded: boolean;
}

export type NoticeKind = "error" | "info";

export interface Notice {
  id: string;
  kind: NoticeKind;
  text: string;
}

export interface AppState {
  connection: ConnectionState;
  /** Đã từng vào trạng thái live; dùng để quyết định hiện màn hình kết nối hay banner mất kết nối. */
  everLive: boolean;
  serverVersion: string | null;
  projects: string[];
  repos: RepoOption[];
  snapshotLoaded: boolean;
  /** last_seq của snapshot gần nhất: event có seq <= giá trị này đã phản ánh trong entity. */
  snapshotSeq: number;
  /** seq lớn nhất đã nhận (gửi lại làm since_seq khi reconnect). */
  lastSeq: number;
  workers: Record<string, Worker>;
  tasks: Record<string, Task>;
  tickets: Ticket[];
  sessions: Record<string, Session>;
  /** Chỉ các request đang chờ quyết định. */
  permissions: Record<string, PermissionRequest>;
  status: SystemStatus | null;
  /** Bus event tăng dần theo seq, không trùng seq. */
  events: BusEvent[];
  /** Khóa: streamKeyForSession / streamKeyForTask. */
  streams: Record<string, StreamState>;
  plannerSessionId: string | null;
  openTaskId: string | null;
  notices: Notice[];
}

export type LocalAction =
  | { type: "local/connection"; connection: ConnectionState }
  | { type: "local/sessions"; sessions: Session[] }
  | { type: "local/session"; session: Session }
  | { type: "local/select-planner"; sessionId: string | null }
  | { type: "local/open-task"; taskId: string | null }
  | { type: "local/notice"; notice: Notice }
  | { type: "local/dismiss-notice"; id: string }
  | { type: "local/permission-cleared"; requestId: string }
  | { type: "local/reset" };

export type Action = ServerMessage | LocalAction;
