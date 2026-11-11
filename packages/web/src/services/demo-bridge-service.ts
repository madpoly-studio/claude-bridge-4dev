// BridgeActions cho chế độ demo: không có backend, chỉ phát message giả vào store cục bộ.
import type {
  BusEvent,
  BusEventType,
  ServerMessage,
  ServerMessageType,
  ServerPayloads,
  Session,
  SessionEventOrigin,
} from "@claude-bridge/protocol";
import { assistantText } from "../demo/fixtures";
import { newId } from "../lib/id";
import { draftFromInput } from "../state/permission-draft";
import { streamKeyForSession, streamKeyForTask } from "../state/reducer";
import type { Store } from "../state/store";
import type { NoticeKind } from "../state/types";
import type { BridgeActions, PermissionResponse } from "./bridge-actions";

const REPLY_DELAY_MS = 700;
const DEMO_NEW_TICKET = "SH-134";

function msg<K extends ServerMessageType>(type: K, payload: ServerPayloads[K]): ServerMessage {
  return { id: newId(), type, payload } as ServerMessage;
}

export class DemoBridgeService implements BridgeActions {
  constructor(private readonly store: Store) {}

  connect(): void {
    this.notify("info", "Chế độ demo: không kết nối backend.");
  }

  disconnect(): void {}

  retryNow(): void {}

  async selectProject(projectKey: string): Promise<boolean> {
    const status = this.store.getState().status;
    if (status) this.store.dispatch(msg("system.status", { ...status, project_key: projectKey }));
    return true;
  }

  async selectPlannerSession(sessionId: string): Promise<boolean> {
    this.store.dispatch({ type: "local/select-planner", sessionId });
    const key = streamKeyForSession(sessionId);
    if (!this.store.getState().streams[key]) {
      this.store.dispatch(msg("session.history", { session_id: sessionId, task_id: null, events: [] }));
    }
    return true;
  }

  async createPlannerSession(repo: string, title?: string): Promise<boolean> {
    const now = new Date().toISOString();
    const session: Session = {
      session_id: `p-${newId().slice(0, 8)}`,
      claude_session_id: null,
      role: "planner",
      project_key: this.store.getState().status?.project_key ?? null,
      repo,
      title: title || null,
      state: "active",
      busy: false,
      created_at: now,
      last_active_at: now,
    };
    this.store.dispatch({ type: "local/session", session });
    return this.selectPlannerSession(session.session_id);
  }

  async sendMessage(sessionId: string, text: string): Promise<boolean> {
    this.pushRecord(sessionId, "user", { type: "user_text", text });
    this.setBusy(sessionId, true);
    setTimeout(() => {
      this.pushRecord(sessionId, "agent", assistantText(`(demo) Đã nhận: “${text}”. Trong chế độ demo không có agent thật.`));
      this.setBusy(sessionId, false);
    }, REPLY_DELAY_MS);
    return true;
  }

  async interrupt(sessionId: string): Promise<boolean> {
    this.setBusy(sessionId, false);
    this.notify("info", "Demo: đã gửi lệnh ngắt.");
    return true;
  }

  async respondPermission(response: PermissionResponse): Promise<boolean> {
    const req = this.store.getState().permissions[response.request_id];
    if (!req) return false;
    const now = new Date().toISOString();
    this.store.dispatch(
      msg("permission.resolved", {
        ...req,
        decision: response.decision,
        updated_input: response.updated_input ?? null,
        reason: response.reason ?? null,
        decided_at: now,
      }),
    );
    if (response.decision === "deny") {
      this.pushRecord(req.session_id, "agent", assistantText(`Đã hủy bản nháp. Lý do: ${response.reason || "(không có)"}. Bạn muốn điều chỉnh gì?`));
      return true;
    }
    const draft = draftFromInput(response.updated_input ?? req.input);
    this.pushRecord(req.session_id, "agent", assistantText(`Đã tạo ${DEMO_NEW_TICKET}: ${draft.title ?? "(không tiêu đề)"}.`));
    const state = this.store.getState();
    this.store.dispatch(
      msg("tickets.updated", {
        tickets: [
          ...state.tickets.filter((t) => t.key !== DEMO_NEW_TICKET),
          {
            key: DEMO_NEW_TICKET,
            summary: draft.title ?? "",
            issue_type: draft.type ?? "Task",
            status: "To Do",
            status_category: "new",
            labels: draft.labels,
            url: `https://jira.example.com/browse/${DEMO_NEW_TICKET}`,
            blocked_by: [],
            updated: now,
          },
        ],
      }),
    );
    this.pushBusEvent("ticket.created", { ticket_key: DEMO_NEW_TICKET, payload: { session_id: req.session_id, labels: draft.labels } });
    return true;
  }

  async setDispatchPaused(paused: boolean): Promise<boolean> {
    const status = this.store.getState().status;
    if (status) this.store.dispatch(msg("system.status", { ...status, dispatch_paused: paused }));
    this.pushBusEvent(paused ? "dispatch.paused" : "dispatch.resumed", {});
    return true;
  }

  async openTask(taskId: string | null): Promise<boolean> {
    this.store.dispatch({ type: "local/open-task", taskId });
    if (taskId && !this.store.getState().streams[streamKeyForTask(taskId)]) {
      this.store.dispatch(msg("session.history", { session_id: null, task_id: taskId, events: [] }));
    }
    return true;
  }

  notify(kind: NoticeKind, text: string): void {
    this.store.dispatch({ type: "local/notice", notice: { id: newId(), kind, text } });
  }

  dismissNotice(id: string): void {
    this.store.dispatch({ type: "local/dismiss-notice", id });
  }

  // ------------------------------------------------------------------

  private pushRecord(sessionId: string, origin: SessionEventOrigin, event: unknown): void {
    const stream = this.store.getState().streams[streamKeyForSession(sessionId)];
    const id = (stream?.lastId ?? 0) + 1;
    this.store.dispatch(msg("session.event", { id, session_id: sessionId, task_id: null, ts: new Date().toISOString(), origin, event }));
  }

  private setBusy(sessionId: string, busy: boolean): void {
    const s = this.store.getState().sessions[sessionId];
    if (s) this.store.dispatch(msg("session.updated", { ...s, busy, last_active_at: new Date().toISOString() }));
  }

  private pushBusEvent(type: BusEventType, extra: Partial<Pick<BusEvent, "ticket_key" | "task_id" | "worker_id" | "payload">>): void {
    const seq = this.store.getState().lastSeq + 1;
    this.store.dispatch(
      msg("bus.event", {
        seq,
        ts: new Date().toISOString(),
        type,
        worker_id: null,
        task_id: null,
        ticket_key: null,
        payload: {},
        ...extra,
      }),
    );
  }
}
