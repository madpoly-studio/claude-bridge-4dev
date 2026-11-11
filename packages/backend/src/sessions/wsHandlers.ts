// Handler WS của Session Manager và Permission Broker (mục 9, P8).
import type { StatusService } from "../status/statusService.js";
import type { BridgeConfig } from "../config.js";
import type { PermissionBroker } from "../permissions/permissionBroker.js";
import { type WsHub, WsError } from "../ws/hub.js";
import { z } from "zod";
import type { OrchestratorManager } from "./orchestrators.js";
import type { ProjectSelection } from "./projectSelection.js";
import type { SessionManager } from "./sessionManager.js";

/** Giới hạn độ dài một tin nhắn chat (ký tự). */
const MAX_TEXT_CHARS = 100_000;
const MAX_REASON_CHARS = 4_000;

const id = z.string().min(1).max(128);
const schemas = {
  projectSelect: z.object({ project_key: z.string().min(1).max(64) }),
  create: z.object({ role: z.literal("planner"), repo: z.string().min(1).max(256), title: z.string().trim().min(1).max(200).optional() }),
  list: z.object({ role: z.enum(["planner", "orchestrator"]) }),
  open: z.object({ session_id: id, since: z.number().int().min(0).optional() }),
  send: z.object({ session_id: id, text: z.string().refine((t) => t.trim() !== "", "text must not be empty").pipe(z.string().max(MAX_TEXT_CHARS)) }),
  sessionOnly: z.object({ session_id: id }),
  respond: z.object({
    request_id: id,
    decision: z.enum(["allow", "deny"]),
    updated_input: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().max(MAX_REASON_CHARS).optional(),
  }),
};

export interface SessionWsDeps {
  hub: WsHub;
  config: BridgeConfig;
  sessions: SessionManager;
  orchestrators: OrchestratorManager;
  broker: PermissionBroker;
  selection: ProjectSelection;
  status: StatusService;
}

export function registerSessionHandlers(deps: SessionWsDeps): void {
  const { hub, config, sessions, orchestrators, broker, selection, status } = deps;

  hub.registerHandler("project.select", schemas.projectSelect, ({ client }, p) => {
    if (!selection.isKnown(p.project_key)) throw new WsError("NOT_FOUND", `project ${p.project_key} is not configured`);
    if (selection.select(client, p.project_key)) status.notifyChanged();
    if (orchestrators.has(p.project_key)) orchestrators.ensureStarted(p.project_key);
    return { project_key: p.project_key, orchestrator_session: orchestrators.sessionFor(p.project_key) };
  });

  hub.registerHandler("session.create", schemas.create, ({ client }, p) => {
    // cwd chỉ từ whitelist (mục 5.2, 12): UI chọn theo tên repo, không bao giờ gửi đường dẫn.
    const repo = config.repos.find((r) => r.name === p.repo);
    if (!repo) throw new WsError("FORBIDDEN", `repo ${p.repo} is not in the repo whitelist`);
    const session = sessions.createPlanner(repo, p.title ?? null);
    client.openSession(session.session_id);
    return { session };
  });

  hub.registerHandler("session.list", schemas.list, (_ctx, p) => ({ sessions: sessions.list(p.role, { includeClosed: true }) }));

  hub.registerHandler("session.open", schemas.open, ({ client }, p) => {
    const session = sessions.require(p.session_id);
    // Đọc lịch sử và đăng ký nhận live trong cùng một tick → không lọt / trùng event.
    const { events, truncated } = sessions.history(session.session_id, p.since ?? 0);
    client.openSession(session.session_id);
    client.send("session.history", {
      session_id: session.session_id,
      task_id: null,
      events,
      truncated,
      first_id: events[0]?.id ?? null,
    });
    return { session };
  });

  hub.registerHandler("session.send", schemas.send, (_ctx, p) => ({ session: sessions.sendText(p.session_id, p.text, "user") }));

  hub.registerHandler("session.interrupt", schemas.sessionOnly, async (_ctx, p) => ({
    interrupted: await sessions.interrupt(p.session_id),
  }));

  hub.registerHandler("session.close", schemas.sessionOnly, (_ctx, p) => {
    const session = sessions.require(p.session_id);
    if (session.role === "orchestrator") throw new WsError("FORBIDDEN", "the orchestrator session is managed by the backend");
    return { session: sessions.close(p.session_id) };
  });

  hub.registerHandler("permission.respond", schemas.respond, (_ctx, p) => ({
    request: broker.respond({
      request_id: p.request_id,
      decision: p.decision,
      ...(p.updated_input !== undefined ? { updated_input: p.updated_input } : {}),
      ...(p.reason !== undefined ? { reason: p.reason } : {}),
    }),
  }));
}
