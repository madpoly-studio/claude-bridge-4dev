// Session Manager (mục 5.2): vòng đời session Claude do bridge spawn — tạo, resume lười theo claude_session_id,
// ghi MỌI event vào session_events trước khi đẩy ra WS, cờ busy theo turn, interrupt, close.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  BridgeNoticeEvent,
  BridgeWelcomeEvent,
  Session,
  SessionEventOrigin,
  SessionRole,
  SessionState,
} from "@claude-bridge/protocol";
import type { ClaudeDriver, ClaudeSessionHandle, ClaudeSessionOptions } from "../claude/driver.js";
import type { RepoConfig } from "../config.js";
import type { EventLog, SessionHistory } from "../events/eventLog.js";
import type { Clock } from "../util/clock.js";
import { shortId } from "../util/ids.js";
import { ListenerSet, type Unsubscribe } from "../util/listeners.js";
import type { Logger } from "../util/logger.js";
import { WsError } from "../ws/hub.js";
import type { SessionRow, SessionStore } from "./sessionStore.js";

/** Chờ process thoát khi backend dừng, quá thời gian thì bỏ qua (process con bị SDK kill). */
const SHUTDOWN_WAIT_MS = 5_000;
/** Số session planner tối đa đưa vào state.snapshot. */
const SNAPSHOT_PLANNER_LIMIT = 200;

export interface SessionMessage {
  session_id: string;
  role: SessionRole;
  message: SDKMessage;
}

export interface SessionEnded {
  session: Session;
  /** Lỗi khi process chết bất thường; null khi kết thúc bình thường. */
  error: Error | null;
  /** true khi do close() / shutdown() — không phải sự cố. */
  expected: boolean;
  /** Thời gian process đã sống, ms. */
  ran_ms: number;
}

export interface SessionManagerDeps {
  store: SessionStore;
  eventLog: EventLog;
  driver: ClaudeDriver;
  clock: Clock;
  /** Dựng options cho session (cwd luôn từ cấu hình). Throw WsError nếu session không chạy được nữa. */
  optionsFor: (row: SessionRow) => ClaudeSessionOptions;
  log: Logger;
}

interface Runtime {
  readonly sessionId: string;
  readonly role: SessionRole;
  readonly handle: ClaudeSessionHandle;
  readonly startedAt: number;
  /** Spawn với `resume` (claude_session_id cũ). */
  readonly resumed: boolean;
  /** Đã nhận `system/init`: CLI đã nạp được conversation. */
  initSeen: boolean;
  busy: boolean;
  closeRequested: boolean;
  done: Promise<void>;
}

export class SessionManager {
  private readonly runtimes = new Map<string, Runtime>();
  private shuttingDown = false;
  private readonly updated = new ListenerSet<Session>("sessions.updated");
  private readonly messages = new ListenerSet<SessionMessage>("sessions.message");
  private readonly turnEnded = new ListenerSet<Session>("sessions.turnEnded");
  private readonly live = new ListenerSet<Session>("sessions.live");
  private readonly ended = new ListenerSet<SessionEnded>("sessions.ended");

  constructor(private readonly deps: SessionManagerDeps) {}

  onUpdated(cb: (s: Session) => void): Unsubscribe {
    return this.updated.add(cb);
  }
  /** Mỗi message SDK, sau khi đã ghi vào session_events. */
  onMessage(cb: (m: SessionMessage) => void): Unsubscribe {
    return this.messages.add(cb);
  }
  /** Sau message `result` (turn kết thúc). */
  onTurnEnded(cb: (s: Session) => void): Unsubscribe {
    return this.turnEnded.add(cb);
  }
  /** Process vừa được spawn (lần đầu hoặc resume). */
  onLive(cb: (s: Session) => void): Unsubscribe {
    return this.live.add(cb);
  }
  onEnded(cb: (e: SessionEnded) => void): Unsubscribe {
    return this.ended.add(cb);
  }

  // ---- tạo / đọc -------------------------------------------------------------------

  /** cwd = đường dẫn repo trong whitelist; process chỉ spawn khi có turn đầu tiên. */
  createPlanner(repo: RepoConfig, title: string | null): Session {
    const row = this.deps.store.insert({
      session_id: shortId("s"),
      role: "planner",
      project_key: repo.project_key,
      repo: repo.name,
      title,
    });
    return this.publish(row);
  }

  createOrchestrator(projectKey: string): Session {
    const row = this.deps.store.insert({
      session_id: shortId("o"),
      role: "orchestrator",
      project_key: projectKey,
      repo: null,
      title: `Orchestrator ${projectKey}`,
    });
    return this.publish(row);
  }

  get(sessionId: string): Session | null {
    const row = this.deps.store.get(sessionId);
    return row ? this.toSession(row) : null;
  }

  require(sessionId: string): Session {
    const session = this.get(sessionId);
    if (!session) throw new WsError("NOT_FOUND", `session ${sessionId} not found`);
    return session;
  }

  list(role: SessionRole, opts: { includeClosed?: boolean; limit?: number } = {}): Session[] {
    return this.deps.store.list(role, opts).map((row) => this.toSession(row));
  }

  findOrchestrator(projectKey: string): Session | null {
    const row = this.deps.store.findOrchestrator(projectKey);
    return row ? this.toSession(row) : null;
  }

  /** Planner chưa đóng + orchestrator của project đang chọn. */
  snapshotSessions(projectKey: string | null): Session[] {
    const sessions = this.list("planner", { limit: SNAPSHOT_PLANNER_LIMIT });
    const orchestrator = projectKey ? this.findOrchestrator(projectKey) : null;
    return orchestrator ? [...sessions, orchestrator] : sessions;
  }

  /** Các event mới nhất có id > since (xem EventLog.readSessionHistory). */
  history(sessionId: string, since: number): SessionHistory {
    return this.deps.eventLog.readSessionHistory({ session_id: sessionId, since });
  }

  isLive(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  isBusy(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.busy === true;
  }

  // ---- điều khiển ------------------------------------------------------------------

  /** Spawn process nếu chưa sống; resume theo claude_session_id nếu đã có (session detached / sau restart). */
  ensureLive(sessionId: string): Session {
    const existing = this.runtimes.get(sessionId);
    if (existing) return this.require(sessionId);
    if (this.shuttingDown) throw new WsError("CONFLICT", "backend is shutting down");
    const row = this.deps.store.get(sessionId);
    if (!row) throw new WsError("NOT_FOUND", `session ${sessionId} not found`);
    if (row.state === "closed") throw new WsError("CONFLICT", `session ${sessionId} is closed`);

    const options = this.deps.optionsFor(row);
    const resume = row.claude_session_id;
    let handle: ClaudeSessionHandle;
    try {
      handle = this.deps.driver.start(resume ? { ...options, resume } : options);
    } catch (err) {
      this.recordNotice(sessionId, `cannot start Claude: ${errorMessage(err)}`);
      this.deps.store.setState(sessionId, "error");
      this.publish(this.deps.store.require(sessionId));
      throw err;
    }
    const rt: Runtime = {
      sessionId,
      role: row.role,
      handle,
      startedAt: this.deps.clock.now(),
      resumed: resume !== null,
      initSeen: false,
      busy: false,
      closeRequested: false,
      done: Promise.resolve(),
    };
    this.runtimes.set(sessionId, rt);
    this.deps.store.setState(sessionId, resume ? "active" : "starting");
    rt.done = this.pump(rt);
    this.deps.log.info({ session_id: sessionId, role: row.role, resumed: resume !== null }, "claude session started");
    const session = this.publish(this.deps.store.require(sessionId));
    this.live.emit(session);
    return session;
  }

  /**
   * Đưa turn cho Claude rồi ghi ngay `{type:"user_text"}` (origin user/system) trong cùng tick, trước mọi message trả
   * lời (luồng message là async). Throw CONFLICT nếu session đang đóng / process đã thoát: turn không bị nuốt im lặng.
   */
  sendText(sessionId: string, text: string, origin: Extract<SessionEventOrigin, "user" | "system">): Session {
    this.ensureLive(sessionId);
    const rt = this.runtimes.get(sessionId) as Runtime;
    if (rt.closeRequested) throw new WsError("CONFLICT", `session ${sessionId} is closing`);
    if (!rt.handle.send(text)) {
      throw new WsError("CONFLICT", `session ${sessionId} cannot accept messages: the Claude process has ended`);
    }
    this.deps.eventLog.appendSessionEvent({ session_id: sessionId, origin, event: { type: "user_text", text } });
    this.deps.store.touch(sessionId);
    rt.busy = true;
    return this.publish(this.deps.store.require(sessionId));
  }

  /** Ghi lời chào của bridge vào luồng session (origin system). Không gửi gì cho Claude, không đổi busy / state. */
  recordWelcome(sessionId: string, text: string): void {
    this.require(sessionId);
    const event: BridgeWelcomeEvent = { type: "bridge_welcome", text };
    this.deps.eventLog.appendSessionEvent({ session_id: sessionId, origin: "system", event });
  }

  /** false nếu session không có process đang sống. */
  async interrupt(sessionId: string): Promise<boolean> {
    this.require(sessionId);
    const rt = this.runtimes.get(sessionId);
    if (!rt) return false;
    await rt.handle.interrupt();
    return true;
  }

  close(sessionId: string): Session {
    const row = this.deps.store.get(sessionId);
    if (!row) throw new WsError("NOT_FOUND", `session ${sessionId} not found`);
    if (row.state !== "closed") {
      this.deps.store.setState(sessionId, "closed");
      const rt = this.runtimes.get(sessionId);
      if (rt) {
        rt.closeRequested = true;
        rt.handle.close();
      }
    }
    return this.publish(this.deps.store.require(sessionId));
  }

  /** Dừng mọi process; session để ở `detached` để resume sau khi backend chạy lại. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const pending = [...this.runtimes.values()].map((rt) => {
      rt.closeRequested = true;
      rt.handle.close();
      return rt.done;
    });
    if (pending.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  // ---- nội bộ ----------------------------------------------------------------------

  private async pump(rt: Runtime): Promise<void> {
    let error: Error | null = null;
    try {
      for await (const message of rt.handle.messages) this.handleMessage(rt, message);
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }
    // rt.done không được ai await đến cuối: lỗi ở đây (DB đã đóng, listener throw) không được thành unhandled rejection.
    try {
      this.finish(rt, error);
    } catch (err) {
      this.deps.log.error({ err, session_id: rt.sessionId }, "failed to finalize claude session");
    }
  }

  private handleMessage(rt: Runtime, message: SDKMessage): void {
    try {
      const { store, eventLog } = this.deps;
      let changed = false;
      if (message.type === "system" && message.subtype === "init") {
        rt.initSeen = true;
        const row = store.require(rt.sessionId);
        if (row.claude_session_id !== message.session_id) store.setClaudeSessionId(rt.sessionId, message.session_id);
        if (row.state !== "active") store.setState(rt.sessionId, "active");
        changed = row.claude_session_id !== message.session_id || row.state !== "active";
      }
      eventLog.appendSessionEvent({ session_id: rt.sessionId, origin: "agent", event: message });
      this.messages.emit({ session_id: rt.sessionId, role: rt.role, message });
      if (message.type === "result") {
        store.touch(rt.sessionId);
        rt.busy = false;
        const session = this.publish(store.require(rt.sessionId));
        this.turnEnded.emit(session);
        return;
      }
      // Turn mới bắt đầu sau một `result` (message người dùng gửi giữa turn được CLI chạy thành turn riêng).
      if (!rt.busy && (message.type === "assistant" || message.type === "user")) {
        rt.busy = true;
        changed = true;
      }
      if (changed) this.publish(store.require(rt.sessionId));
    } catch (err) {
      this.deps.log.error({ err, session_id: rt.sessionId }, "failed to handle claude message");
    }
  }

  private finish(rt: Runtime, error: Error | null): void {
    this.runtimes.delete(rt.sessionId);
    rt.busy = false;
    const { store } = this.deps;
    const row = store.get(rt.sessionId);
    if (!row) return;
    const expected = rt.closeRequested || this.shuttingDown;
    // Resume chết trước `init` (vd. "No conversation found" vì transcript đã bị dọn): resume lại sẽ chết y hệt,
    // nên quên claude_session_id để lần spawn sau bắt đầu conversation mới thay vì kẹt mãi.
    const staleResume = !expected && rt.resumed && !rt.initSeen && error !== null && row.claude_session_id !== null;
    if (staleResume) {
      store.setClaudeSessionId(rt.sessionId, null);
      this.recordNotice(
        rt.sessionId,
        `Claude could not resume conversation ${row.claude_session_id}; the next turn starts a new conversation.`,
      );
      this.deps.log.warn({ session_id: rt.sessionId, claude_session_id: row.claude_session_id }, "stale claude session id cleared");
    }
    let state: SessionState;
    if (row.state === "closed") state = "closed";
    else if (staleResume) state = "detached";
    else if (expected) state = "detached";
    // Process chết: còn claude_session_id thì resume được ở turn sau.
    else state = row.claude_session_id ? "detached" : "error";
    if (!expected) {
      this.recordNotice(rt.sessionId, error ? `Claude process failed: ${error.message}` : "Claude process exited");
      this.deps.log.warn({ session_id: rt.sessionId, err: error?.message ?? null }, "claude session ended unexpectedly");
    }
    store.setState(rt.sessionId, state);
    const session = this.publish(store.require(rt.sessionId));
    this.ended.emit({ session, error, expected, ran_ms: this.deps.clock.now() - rt.startedAt });
  }

  private recordNotice(sessionId: string, message: string): void {
    const event: BridgeNoticeEvent = { type: "bridge_notice", message };
    this.deps.eventLog.appendSessionEvent({ session_id: sessionId, origin: "system", event });
  }

  private toSession(row: SessionRow): Session {
    return { ...row, busy: this.runtimes.get(row.session_id)?.busy === true };
  }

  private publish(row: SessionRow): Session {
    const session = this.toSession(row);
    this.updated.emit(session);
    return session;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
