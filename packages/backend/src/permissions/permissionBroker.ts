// Permission Broker (mục 5.3): gate "chốt solution" của planner. Tool tạo issue Jira bị chặn ở canUseTool, chờ người
// dùng Duyệt / Sửa / Hủy trên UI; khi tool đã duyệt trả kết quả thành công thì phát `ticket.created`.
import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionDecision, PermissionRequest } from "@claude-bridge/protocol";
import type { TaskBus } from "../bus/taskBus.js";
import { shortId } from "../util/ids.js";
import { ListenerSet, type Unsubscribe } from "../util/listeners.js";
import type { Logger } from "../util/logger.js";
import { WsError } from "../ws/hub.js";
import type { PermissionStore } from "./permissionStore.js";
import { extractLabels, extractProjectKey, extractTicketKey, toolResultTexts } from "./ticketExtraction.js";

/** Lý do ghi cho request bị hủy vì session / backend không còn (query đã mất). */
export const EXPIRED_REASON = "expired";
/** Planner nhận thông điệp này khi người dùng Hủy mà không ghi lý do. */
export const DEFAULT_DENY_MESSAGE =
  "Người dùng đã hủy việc tạo ticket. Hãy hỏi người dùng cần chỉnh gì trong bản nháp trước khi đề xuất lại.";
const EXPIRED_DENY_MESSAGE = "Yêu cầu tạo ticket đã hết hiệu lực (session bị ngắt). Không tạo ticket.";

export interface ApprovalRequest {
  session_id: string;
  tool: string;
  input: Record<string, unknown>;
  tool_use_id: string;
  signal: AbortSignal;
}

export interface PermissionResponse {
  request_id: string;
  decision: PermissionDecision;
  updated_input?: Record<string, unknown>;
  reason?: string;
}

interface Pending {
  request: ApprovalRequest;
  resolve: (result: PermissionResult) => void;
  onAbort: () => void;
}

interface Approved {
  session_id: string;
  /** Input thật sự được chạy (bản đã sửa nếu người dùng chọn Sửa). */
  input: Record<string, unknown>;
}

export interface PermissionBrokerDeps {
  store: PermissionStore;
  bus: TaskBus;
  log: Logger;
}

export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  /** tool_use_id đã được duyệt → chờ tool_result để phát ticket.created. */
  private readonly approved = new Map<string, Approved>();
  private readonly requested = new ListenerSet<PermissionRequest>("permission.request");
  private readonly resolved = new ListenerSet<PermissionRequest>("permission.resolved");

  constructor(private readonly deps: PermissionBrokerDeps) {}

  onRequest(cb: (r: PermissionRequest) => void): Unsubscribe {
    return this.requested.add(cb);
  }

  onResolved(cb: (r: PermissionRequest) => void): Unsubscribe {
    return this.resolved.add(cb);
  }

  listPending(): PermissionRequest[] {
    return this.deps.store.listPending();
  }

  /** Lưu request, phát `permission.request`, chờ quyết định. Signal bị abort (interrupt / session chết) → hết hiệu lực. */
  requestApproval(req: ApprovalRequest): Promise<PermissionResult> {
    const record = this.deps.store.insert({
      request_id: shortId("p"),
      session_id: req.session_id,
      tool: req.tool,
      input: req.input,
    });
    if (req.signal.aborted) {
      this.expire(record.request_id);
      return Promise.resolve({ behavior: "deny", message: EXPIRED_DENY_MESSAGE });
    }
    return new Promise<PermissionResult>((resolve) => {
      const onAbort = (): void => this.expire(record.request_id);
      this.pending.set(record.request_id, { request: req, resolve, onAbort });
      req.signal.addEventListener("abort", onAbort, { once: true });
      this.requested.emit(record);
    });
  }

  /** Duyệt → allow (input gốc); Sửa → allow với updated_input; Hủy → deny kèm lý do để planner tiếp tục hội thoại. */
  respond(res: PermissionResponse): PermissionRequest {
    const entry = this.pending.get(res.request_id);
    if (!entry) {
      const existing = this.deps.store.get(res.request_id);
      if (!existing) throw new WsError("NOT_FOUND", `permission request ${res.request_id} not found`);
      throw new WsError("CONFLICT", `permission request ${res.request_id} is already ${existing.decision ?? "resolved"}`);
    }
    const allow = res.decision === "allow";
    const updatedInput = allow ? (res.updated_input ?? null) : null;
    const reason = allow ? null : (res.reason?.trim() || null);
    if (!this.deps.store.decide(res.request_id, res.decision, updatedInput, reason)) {
      throw new WsError("CONFLICT", `permission request ${res.request_id} is already resolved`);
    }
    const effectiveInput = updatedInput ?? entry.request.input;
    if (allow) this.approved.set(entry.request.tool_use_id, { session_id: entry.request.session_id, input: effectiveInput });
    this.settle(res.request_id, entry, allow ? { behavior: "allow", updatedInput: effectiveInput } : { behavior: "deny", message: reason ?? DEFAULT_DENY_MESSAGE });
    return this.deps.store.require(res.request_id);
  }

  /** Session chết / đóng / interrupt: mọi request đang chờ của session bị từ chối với lý do "expired". */
  expireSession(sessionId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.request.session_id === sessionId) this.expire(requestId);
    }
    for (const [toolUseId, approved] of this.approved) {
      if (approved.session_id === sessionId) this.approved.delete(toolUseId);
    }
    // Request còn trong DB mà không có trong bộ nhớ (không xảy ra trong một process, giữ để chắc chắn nhất quán).
    for (const stale of this.deps.store.listPending(sessionId)) this.expireStored(stale.request_id);
  }

  /** Khi backend khởi động: query của mọi request đang chờ đã mất. */
  expireAllStored(): number {
    const stale = this.deps.store.listPending();
    for (const req of stale) this.deps.store.decide(req.request_id, "deny", null, EXPIRED_REASON);
    return stale.length;
  }

  /** Theo dõi message của planner: tool_result thành công của tool đã duyệt → `ticket.created`. */
  observe(sessionId: string, message: SDKMessage): void {
    if (message.type !== "user" || this.approved.size === 0) return;
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (typeof block !== "object" || block === null || block.type !== "tool_result") continue;
      const approved = this.approved.get(block.tool_use_id);
      if (!approved || approved.session_id !== sessionId) continue;
      this.approved.delete(block.tool_use_id);
      if (block.is_error === true) {
        this.deps.log.info({ session_id: sessionId, tool_use_id: block.tool_use_id }, "approved create-issue tool returned an error");
        continue;
      }
      this.emitTicketCreated(sessionId, approved.input, [...toolResultTexts(block.content), message.tool_use_result]);
    }
  }

  private emitTicketCreated(sessionId: string, input: Record<string, unknown>, sources: unknown[]): void {
    const ticketKey = extractTicketKey(
      sources.filter((s) => s !== undefined && s !== null),
      extractProjectKey(input),
    );
    if (!ticketKey) {
      this.deps.log.warn({ session_id: sessionId }, "create-issue tool succeeded but no Jira key was found in its result");
      return;
    }
    try {
      this.deps.bus.emitTicketCreated({ ticket_key: ticketKey, session_id: sessionId, labels: extractLabels(input) });
    } catch (err) {
      this.deps.log.error({ err, session_id: sessionId, ticket_key: ticketKey }, "failed to emit ticket.created");
    }
  }

  private expire(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.deps.store.decide(requestId, "deny", null, EXPIRED_REASON);
    this.settle(requestId, entry, { behavior: "deny", message: EXPIRED_DENY_MESSAGE });
  }

  private expireStored(requestId: string): void {
    if (this.deps.store.decide(requestId, "deny", null, EXPIRED_REASON)) this.resolved.emit(this.deps.store.require(requestId));
  }

  private settle(requestId: string, entry: Pending, result: PermissionResult): void {
    this.pending.delete(requestId);
    entry.request.signal.removeEventListener("abort", entry.onAbort);
    entry.resolve(result);
    this.resolved.emit(this.deps.store.require(requestId));
  }
}
