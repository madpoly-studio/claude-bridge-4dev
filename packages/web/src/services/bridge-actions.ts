import type { PermissionDecision } from "@claude-bridge/protocol";
import type { NoticeKind } from "../state/types";

export interface PermissionResponse {
  request_id: string;
  decision: PermissionDecision;
  updated_input?: Record<string, unknown>;
  reason?: string;
}

export interface ConnectOptions {
  /** true: nhớ token trong localStorage; false: chỉ sessionStorage; bỏ trống: giữ nơi đang lưu. */
  remember?: boolean;
}

/**
 * Mọi thao tác UI gửi tới backend. Hai bản cài đặt: live (WebSocket) và demo (chỉ đổi state cục bộ).
 * Các hàm trả `true` khi thành công; lỗi được đẩy thành notice, không ném ra ngoài.
 */
export interface BridgeActions {
  connect(url: string, token: string, options?: ConnectOptions): void;
  disconnect(): void;
  retryNow(): void;
  selectProject(projectKey: string): Promise<boolean>;
  selectPlannerSession(sessionId: string): Promise<boolean>;
  createPlannerSession(repo: string, title?: string): Promise<boolean>;
  sendMessage(sessionId: string, text: string): Promise<boolean>;
  interrupt(sessionId: string): Promise<boolean>;
  respondPermission(response: PermissionResponse): Promise<boolean>;
  setDispatchPaused(paused: boolean): Promise<boolean>;
  openTask(taskId: string | null): Promise<boolean>;
  notify(kind: NoticeKind, text: string): void;
  dismissNotice(id: string): void;
}
