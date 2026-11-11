// Phase 4 (mục 18): Duyệt / Sửa / Hủy đều đúng; ticket chỉ được tạo sau khi duyệt; ticket.created mang đúng
// ticket_key và labels; request đang chờ hết hiệu lực khi session chết hoặc backend restart.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeToolOutcome, FakeTurn } from "../src/claude/fakeDriver.js";
import { openDatabase } from "../src/db/database.js";
import { extractLabels, extractTicketKey } from "../src/permissions/ticketExtraction.js";
import { type AgentHarness, startAgentHarness } from "./agentHarness.js";
import type { Msg, TestWs } from "./wsClient.js";

const CREATE_TOOL = "mcp__jira__jira_create_issue";
const DRAFT = {
  project_key: "SH",
  summary: "Sửa lỗi đăng nhập",
  issue_type: "Bug",
  description: "Giải pháp + tiêu chí nghiệm thu",
  additional_fields: { labels: ["agent", "backend"] },
};

interface CreateRun {
  outcome: FakeToolOutcome | null;
  executedWith: Record<string, unknown> | null;
}

/** Turn "tạo" gọi tool tạo issue; server Jira giả trả `{key, self}` (giống mcp-atlassian). */
function scriptCreate(h: AgentHarness, run: CreateRun, opts: { key?: string; isError?: boolean } = {}): void {
  h.driver.script = async (turn: FakeTurn) => {
    if (turn.text !== "tạo") {
      turn.say(`ok: ${turn.text}`);
      return;
    }
    run.outcome = await turn.useTool(
      CREATE_TOOL,
      DRAFT,
      (input) => {
        run.executedWith = input;
        return opts.isError ? "Jira error 400: summary is required" : { key: opts.key ?? "SH-131", self: "https://jira/rest/api/2/issue/99" };
      },
      opts.isError ? { isError: true } : {},
    );
    turn.say(run.outcome.allowed ? "Đã tạo ticket" : `Bị từ chối: ${run.outcome.message}`);
  };
}

const ticketEvents = (h: AgentHarness) => h.bridge.eventLog.readBusEventsSince(0).filter((e) => e.type === "ticket.created");

async function startCreate(h: AgentHarness): Promise<{ ws: TestWs; sid: string; request: Msg }> {
  const ws = await h.open();
  const created = await ws.request("session.create", { role: "planner", repo: "sh" });
  const sid = created.payload.result.session.session_id as string;
  await ws.request("session.send", { session_id: sid, text: "tạo" });
  const request = await ws.waitFor((m) => m.type === "permission.request");
  return { ws, sid, request };
}

describe("Permission Broker", () => {
  let h: AgentHarness;
  afterEach(async () => {
    await h?.dispose();
  });

  it("Approve: tool runs with the original input, then ticket.created carries the key and labels", async () => {
    h = await startAgentHarness();
    const run: CreateRun = { outcome: null, executedWith: null };
    scriptCreate(h, run);
    const { ws, sid, request } = await startCreate(h);
    expect(request.payload).toMatchObject({ session_id: sid, tool: CREATE_TOOL, input: DRAFT, decision: null });

    // Đang chờ: chưa chạy tool, chưa có ticket, request có trong snapshot của client mới.
    expect(run.executedWith).toBeNull();
    expect(ticketEvents(h)).toHaveLength(0);
    const late = await h.open();
    const snap = await late.waitFor((m) => m.type === "state.snapshot");
    expect(snap.payload.pending_permissions.map((p: { request_id: string }) => p.request_id)).toEqual([request.payload.request_id]);

    const ack = await ws.request("permission.respond", { request_id: request.payload.request_id, decision: "allow" });
    expect(ack.payload.result.request).toMatchObject({ decision: "allow", updated_input: null, decided_at: expect.any(String) });
    const resolved = await ws.waitFor((m) => m.type === "permission.resolved");
    expect(resolved.payload.decision).toBe("allow");

    await vi.waitFor(() => expect(ticketEvents(h)).toHaveLength(1));
    expect(run.executedWith).toEqual(DRAFT);
    const event = ticketEvents(h)[0];
    expect(event).toMatchObject({
      ticket_key: "SH-131",
      payload: { session_id: sid, labels: ["agent", "backend"], has_agent_label: true },
    });
    await ws.waitFor((m) => m.type === "bus.event" && m.payload.type === "ticket.created");
    expect(h.bridge.agents.broker.listPending()).toHaveLength(0);
    // Trả lời lại một request đã xong → CONFLICT.
    const again = await ws.request("permission.respond", { request_id: request.payload.request_id, decision: "deny" });
    expect(again.payload.code).toBe("CONFLICT");
    const unknown = await ws.request("permission.respond", { request_id: "p-nope", decision: "allow" });
    expect(unknown.payload.code).toBe("NOT_FOUND");
  });

  it("Edit: the edited input reaches the tool and drives the labels", async () => {
    h = await startAgentHarness();
    const run: CreateRun = { outcome: null, executedWith: null };
    scriptCreate(h, run, { key: "SH-132" });
    const { ws, request } = await startCreate(h);
    const edited = { ...DRAFT, summary: "Sửa lỗi đăng nhập (đã chỉnh)", labels: ["backend"], additional_fields: {} };
    await ws.request("permission.respond", { request_id: request.payload.request_id, decision: "allow", updated_input: edited });
    await vi.waitFor(() => expect(ticketEvents(h)).toHaveLength(1));
    expect(run.executedWith).toEqual(edited);
    expect(h.bridge.agents.broker.listPending()).toHaveLength(0);
    const stored = openDatabase(`${h.dir}/bridge.db`);
    const row = stored.prepare("SELECT updated_input FROM permission_requests").get() as { updated_input: string };
    stored.close();
    expect(JSON.parse(row.updated_input)).toEqual(edited);
    expect(ticketEvents(h)[0]).toMatchObject({ ticket_key: "SH-132", payload: { labels: ["backend"], has_agent_label: false } });
  });

  it("Cancel: the planner gets the reason, continues the conversation, and no ticket is created", async () => {
    h = await startAgentHarness();
    const run: CreateRun = { outcome: null, executedWith: null };
    scriptCreate(h, run);
    const { ws, sid, request } = await startCreate(h);
    await ws.request("permission.respond", { request_id: request.payload.request_id, decision: "deny", reason: "Thiếu tiêu chí nghiệm thu" });
    await ws.waitFor((m) => m.type === "session.event" && m.payload.event?.type === "result");
    expect(run.outcome).toMatchObject({ allowed: false, message: "Thiếu tiêu chí nghiệm thu" });
    expect(run.executedWith).toBeNull();
    const toolResult = h.bridge.eventLog
      .readSessionEvents({ session_id: sid })
      .find((r) => JSON.stringify(r.event).includes("Thiếu tiêu chí nghiệm thu"));
    expect(toolResult?.origin).toBe("agent");

    await ws.request("session.send", { session_id: sid, text: "bổ sung AC" });
    await vi.waitFor(() =>
      expect(ws.messages.filter((m) => m.type === "session.event" && m.payload.event?.type === "result")).toHaveLength(2),
    );
    expect(ticketEvents(h)).toHaveLength(0);
  });

  it("Cancel without a reason sends the default message", async () => {
    h = await startAgentHarness();
    const run: CreateRun = { outcome: null, executedWith: null };
    scriptCreate(h, run);
    const { ws, request } = await startCreate(h);
    await ws.request("permission.respond", { request_id: request.payload.request_id, decision: "deny" });
    await vi.waitFor(() => expect(run.outcome).not.toBeNull());
    expect(run.outcome?.message).toMatch(/hủy/);
  });

  it("an approved tool that fails does not emit ticket.created", async () => {
    h = await startAgentHarness();
    const run: CreateRun = { outcome: null, executedWith: null };
    scriptCreate(h, run, { isError: true });
    const { ws, request } = await startCreate(h);
    await ws.request("permission.respond", { request_id: request.payload.request_id, decision: "allow" });
    await ws.waitFor((m) => m.type === "session.event" && m.payload.event?.type === "result");
    expect(run.executedWith).toEqual(DRAFT);
    expect(ticketEvents(h)).toHaveLength(0);
  });

  it("a pending request expires when the session dies or the turn is interrupted", async () => {
    h = await startAgentHarness();
    const run: CreateRun = { outcome: null, executedWith: null };
    scriptCreate(h, run);
    const { ws, sid, request } = await startCreate(h);
    h.driver.last().crash();
    const resolved = await ws.waitFor((m) => m.type === "permission.resolved");
    expect(resolved.payload).toMatchObject({ request_id: request.payload.request_id, decision: "deny", reason: "expired" });
    await vi.waitFor(() => expect(h.bridge.agents.sessions.get(sid)?.state).toBe("detached"));
    const late = await ws.request("permission.respond", { request_id: request.payload.request_id, decision: "allow" });
    expect(late.payload.code).toBe("CONFLICT");
    expect(run.executedWith).toBeNull();

    // Interrupt giữa lúc chờ duyệt: signal của canUseTool bị abort → hết hiệu lực.
    await ws.request("session.send", { session_id: sid, text: "tạo" });
    const second = await ws.waitFor((m) => m.type === "permission.request" && m.payload.request_id !== request.payload.request_id);
    await ws.request("session.interrupt", { session_id: sid });
    const expired = await ws.waitFor((m) => m.type === "permission.resolved" && m.payload.request_id === second.payload.request_id);
    expect(expired.payload.reason).toBe("expired");
    expect(ticketEvents(h)).toHaveLength(0);
    expect(h.bridge.agents.broker.listPending()).toHaveLength(0);
  });

  it("requests left pending by a crashed backend are expired at startup", async () => {
    h = await startAgentHarness();
    const dir = h.dir;
    await h.stop();
    const db = openDatabase(`${dir}/bridge.db`);
    db.prepare(
      "INSERT INTO permission_requests (request_id, session_id, tool, input, created_at) VALUES ('p-old', 's-old', ?, '{}', '2026-11-11T09:00:00.000Z')",
    ).run(CREATE_TOOL);
    db.close();
    h = await startAgentHarness({ dir });
    expect(h.bridge.agents.broker.listPending()).toHaveLength(0);
    const db2 = openDatabase(`${dir}/bridge.db`);
    const row = db2.prepare("SELECT decision, reason FROM permission_requests WHERE request_id = 'p-old'").get();
    db2.close();
    expect(row).toEqual({ decision: "deny", reason: "expired" });
  });
});

describe("ticket extraction", () => {
  it("prefers key fields in JSON, then a key of the input's project", () => {
    expect(extractTicketKey(['{"id":"10001","key":"SH-7","self":"x"}'], null)).toBe("SH-7");
    expect(extractTicketKey(['{"issue":{"issueKey":"SH-8"}}'], null)).toBe("SH-8");
    expect(extractTicketKey(["Encoding UTF-8. Created issue SH-9."], "SH")).toBe("SH-9");
    expect(extractTicketKey(["Created issue SH-9."], null)).toBe("SH-9");
    expect(extractTicketKey([{ structuredContent: { key: "SH-10" } }], null)).toBe("SH-10");
    expect(extractTicketKey(["no key here"], null)).toBeNull();
  });

  it("collects labels from labels, fields.labels and additional_fields (object or JSON string)", () => {
    expect(extractLabels({ labels: ["agent"], fields: { labels: ["a", "agent"] } })).toEqual(["agent", "a"]);
    expect(extractLabels({ additional_fields: '{"labels":["agent","x"]}' })).toEqual(["agent", "x"]);
    expect(extractLabels({ labels: "agent, y" })).toEqual(["agent", "y"]);
    expect(extractLabels({})).toEqual([]);
  });
});
