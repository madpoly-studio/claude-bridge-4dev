// Cài đặt BridgeActions qua BridgeClient (WebSocket). Đồng bộ store với message server
// và lo phần side effect: mở lại luồng session sau reconnect, thông báo trình duyệt.
import type { ClientMessageType, ClientPayloads, ServerMessage, Session } from "@claude-bridge/protocol";
import { STORAGE_KEYS } from "../config";
import { newId } from "../lib/id";
import { writeStorage, readStorage } from "../lib/storage";
import { loadToken, saveToken } from "../lib/token-storage";
import { draftFromInput } from "../state/permission-draft";
import { streamKeyForRecord, streamKeyForSession, streamKeyForTask } from "../state/reducer";
import { displayedStreamKeys, orchestratorSession, pickDefaultPlannerSession, plannerSessions } from "../state/selectors";
import type { Store } from "../state/store";
import type { NoticeKind } from "../state/types";
import { BridgeClient, BridgeRequestError } from "../ws/client";
import type { TransportFactory } from "../ws/transport";
import type { BridgeActions, ConnectOptions, PermissionResponse } from "./bridge-actions";
import { showBrowserNotification } from "./notifier";

export interface LiveServiceOptions {
  transport?: TransportFactory;
}

function isSessionList(v: unknown): v is Session[] {
  return Array.isArray(v) && v.every((s) => typeof s === "object" && s !== null && "session_id" in s);
}

function isSession(v: unknown): v is Session {
  return typeof v === "object" && v !== null && "session_id" in v && "role" in v;
}

/** Backend bọc kết quả trong một khóa (`{session}`, `{sessions}`); nhận cả dạng trần lẫn dạng bọc. */
function unwrap(v: unknown, key: string): unknown {
  if (typeof v === "object" && v !== null && !Array.isArray(v) && key in v) return (v as Record<string, unknown>)[key];
  return v;
}

export class LiveBridgeService implements BridgeActions {
  private client: BridgeClient | null = null;
  /** Khóa luồng đã gửi open trong kết nối hiện tại (server cần open lại sau mỗi lần reconnect). */
  private opened = new Set<string>();
  private orchestratorOpenedId: string | null = null;
  private currentTarget: { url: string; token: string } | null = null;

  constructor(
    private readonly store: Store,
    private readonly options: LiveServiceOptions = {},
  ) {}

  connect(url: string, token: string, options: ConnectOptions = {}): void {
    writeStorage(STORAGE_KEYS.wsUrl, url);
    // Không nói rõ thì giữ nguyên nơi đang lưu token (sessionStorage mặc định, localStorage nếu đã chọn ghi nhớ).
    saveToken(token, options.remember ?? loadToken().remember);
    const changed = !this.currentTarget || this.currentTarget.url !== url || this.currentTarget.token !== token;
    this.client?.stop();
    if (changed) this.store.dispatch({ type: "local/reset" });
    this.currentTarget = { url, token };
    this.client = new BridgeClient({
      url,
      token,
      transport: this.options.transport,
      getSinceSeq: () => {
        const seq = this.store.getState().lastSeq;
        return seq > 0 ? seq : undefined;
      },
      onConnection: (connection) => {
        this.store.dispatch({ type: "local/connection", connection });
        if (connection.phase === "syncing") this.resetOpened();
      },
      onMessage: (msg) => this.handleMessage(msg),
    });
    this.client.start();
  }

  disconnect(): void {
    this.client?.stop();
    this.client = null;
  }

  retryNow(): void {
    this.client?.retryNow();
  }

  async selectProject(projectKey: string): Promise<boolean> {
    return this.call("project.select", { project_key: projectKey }, "Không đổi được project");
  }

  async selectPlannerSession(sessionId: string): Promise<boolean> {
    this.store.dispatch({ type: "local/select-planner", sessionId });
    writeStorage(STORAGE_KEYS.plannerSession, sessionId);
    this.releaseHiddenStreams();
    return this.openSessionStream(sessionId);
  }

  async createPlannerSession(repo: string, title?: string): Promise<boolean> {
    const payload: ClientPayloads["session.create"] = title ? { role: "planner", repo, title } : { role: "planner", repo };
    const raw = await this.request("session.create", payload, "Không tạo được phiên mới");
    if (raw === undefined) return false;
    const result = unwrap(raw, "session");
    if (isSession(result)) {
      this.store.dispatch({ type: "local/session", session: result });
      await this.selectPlannerSession(result.session_id);
    } else {
      await this.loadPlannerSessions();
    }
    return true;
  }

  async sendMessage(sessionId: string, text: string): Promise<boolean> {
    return this.call("session.send", { session_id: sessionId, text }, "Không gửi được tin nhắn");
  }

  async interrupt(sessionId: string): Promise<boolean> {
    return this.call("session.interrupt", { session_id: sessionId }, "Không ngắt được turn");
  }

  async respondPermission(response: PermissionResponse): Promise<boolean> {
    const ok = await this.call("permission.respond", response, "Không gửi được quyết định");
    if (ok) this.store.dispatch({ type: "local/permission-cleared", requestId: response.request_id });
    return ok;
  }

  async setDispatchPaused(paused: boolean): Promise<boolean> {
    return paused
      ? this.call("dispatch.pause", {}, "Không dừng được giao việc")
      : this.call("dispatch.resume", {}, "Không tiếp tục được giao việc");
  }

  async openTask(taskId: string | null): Promise<boolean> {
    this.store.dispatch({ type: "local/open-task", taskId });
    this.releaseHiddenStreams();
    if (!taskId) return true;
    return this.openTaskStream(taskId);
  }

  notify(kind: NoticeKind, text: string): void {
    this.store.dispatch({ type: "local/notice", notice: { id: newId(), kind, text } });
  }

  dismissNotice(id: string): void {
    this.store.dispatch({ type: "local/dismiss-notice", id });
  }

  // ------------------------------------------------------------------ internals

  private handleMessage(msg: ServerMessage): void {
    // Backend vẫn đẩy event của luồng đã mở trước đó (chưa có session.unsubscribe/task.close):
    // bỏ qua luồng không còn hiển thị để bộ nhớ không tăng mãi.
    if (!this.isDisplayedStream(msg)) return;
    const live = this.store.getState().connection.phase === "live";
    this.store.dispatch(msg);
    switch (msg.type) {
      case "replay.done":
        void this.onSynced();
        break;
      case "state.snapshot":
      case "session.updated":
      case "system.status":
        if (this.store.getState().connection.phase === "live") this.ensureOrchestratorOpen();
        break;
      case "permission.request":
        if (live) {
          showBrowserNotification(
            "Bản nháp ticket chờ duyệt",
            draftFromInput(msg.payload.input).title ?? msg.payload.tool,
            msg.payload.request_id,
          );
        }
        break;
      case "bus.event":
        if (live && msg.payload.type === "task.failed") {
          const p = msg.payload.payload as { category?: string; attempt?: number };
          showBrowserNotification(
            `Task lỗi: ${msg.payload.ticket_key ?? msg.payload.task_id ?? ""}`,
            [p.category, p.attempt ? `lần ${p.attempt}` : null].filter(Boolean).join(" · "),
            `task-failed-${msg.payload.seq}`,
          );
        }
        break;
      case "error":
        if (msg.payload?.message) this.notify("error", `${msg.payload.code}: ${msg.payload.message}`);
        break;
      default:
        break;
    }
  }

  private isDisplayedStream(msg: ServerMessage): boolean {
    let key: string | null;
    if (msg.type === "session.event") {
      if (typeof msg.payload?.id !== "number") return true;
      key = streamKeyForRecord(msg.payload);
    } else if (msg.type === "session.history") {
      const { session_id, task_id } = msg.payload;
      key = task_id ? streamKeyForTask(task_id) : session_id ? streamKeyForSession(session_id) : null;
    } else {
      return true;
    }
    return key === null || displayedStreamKeys(this.store.getState()).has(key);
  }

  /**
   * Bỏ luồng không còn hiển thị (giữ planner đang chọn, orchestrator, task đang mở) và xóa dấu "đã mở"
   * để lần mở lại tải lịch sử từ đầu.
   */
  private releaseHiddenStreams(): void {
    const state = this.store.getState();
    const keep = displayedStreamKeys(state);
    for (const key of [...this.opened]) if (!keep.has(key)) this.opened.delete(key);
    const drop = Object.keys(state.streams).filter((key) => !keep.has(key));
    if (drop.length > 0) this.store.dispatch({ type: "local/drop-streams", keys: drop });
  }

  private resetOpened(): void {
    this.opened.clear();
    this.orchestratorOpenedId = null;
  }

  /** Sau replay.done: tải danh sách phiên planner, mở lại các luồng đang xem từ id cuối. */
  private async onSynced(): Promise<void> {
    await this.loadPlannerSessions();
    this.ensureOrchestratorOpen();
    const { openTaskId } = this.store.getState();
    if (openTaskId) void this.openTaskStream(openTaskId);
  }

  private async loadPlannerSessions(): Promise<void> {
    const result = unwrap(
      await this.request("session.list", { role: "planner" }, "Không tải được danh sách phiên planner"),
      "sessions",
    );
    if (isSessionList(result)) this.store.dispatch({ type: "local/sessions", sessions: result });
    const state = this.store.getState();
    const preferred = state.plannerSessionId ?? readStorage(STORAGE_KEYS.plannerSession);
    const id = pickDefaultPlannerSession(plannerSessions(state), preferred);
    if (id) await this.selectPlannerSession(id);
  }

  private ensureOrchestratorOpen(): void {
    const orch = orchestratorSession(this.store.getState());
    if (!orch || orch.session_id === this.orchestratorOpenedId) return;
    const switched = this.orchestratorOpenedId !== null;
    this.orchestratorOpenedId = orch.session_id;
    // Đổi project → orchestrator khác: bỏ luồng của orchestrator cũ.
    if (switched) this.releaseHiddenStreams();
    void this.openSessionStream(orch.session_id);
  }

  private async openSessionStream(sessionId: string): Promise<boolean> {
    const key = streamKeyForSession(sessionId);
    if (this.opened.has(key)) return true;
    this.opened.add(key);
    const lastId = this.store.getState().streams[key]?.lastId ?? 0;
    const ok = await this.call(
      "session.open",
      lastId > 0 ? { session_id: sessionId, since: lastId } : { session_id: sessionId },
      "Không mở được phiên",
    );
    if (!ok) this.opened.delete(key);
    return ok;
  }

  private async openTaskStream(taskId: string): Promise<boolean> {
    const key = streamKeyForTask(taskId);
    if (this.opened.has(key)) return true;
    this.opened.add(key);
    const lastId = this.store.getState().streams[key]?.lastId ?? 0;
    const ok = await this.call("task.open", lastId > 0 ? { task_id: taskId, since: lastId } : { task_id: taskId }, "Không mở được luồng task");
    if (!ok) this.opened.delete(key);
    return ok;
  }

  private async call<K extends ClientMessageType>(type: K, payload: ClientPayloads[K], errorText: string): Promise<boolean> {
    return (await this.request(type, payload, errorText)) !== undefined;
  }

  /** Trả result của ack (null nếu ack rỗng), hoặc undefined khi lỗi (đã đẩy notice). */
  private async request<K extends ClientMessageType>(type: K, payload: ClientPayloads[K], errorText: string): Promise<unknown> {
    if (!this.client) {
      this.notify("error", `${errorText}: chưa kết nối backend`);
      return undefined;
    }
    try {
      const result = await this.client.request(type, payload);
      return result === undefined ? null : result;
    } catch (e) {
      const detail = e instanceof BridgeRequestError ? e.message : e instanceof Error ? e.message : String(e);
      this.notify("error", `${errorText}: ${detail}`);
      return undefined;
    }
  }
}
