// Phase 3 (mục 18): tạo session planner, chat nhiều turn, ngắt turn, restart backend rồi resume đúng lịch sử;
// cwd ngoài whitelist bị từ chối; tool ngoài allowlist bị từ chối.
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_CREDENTIAL_ENV_VARS, buildClaudeEnv } from "../src/claude/auth.js";
import type { FakeToolOutcome } from "../src/claude/fakeDriver.js";
import { ToolPolicy, matchesToolPattern } from "../src/claude/toolPolicy.js";
import { ConfigError } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { type AgentHarness, startAgentHarness } from "./agentHarness.js";
import { removeDir } from "./helpers.js";
import type { Msg, TestWs } from "./wsClient.js";

const isResult = (sid: string) => (m: Msg) =>
  m.type === "session.event" && m.payload.session_id === sid && m.payload.event?.type === "result";

function countResults(ws: TestWs, sid: string): number {
  return ws.messages.filter(isResult(sid)).length;
}

async function waitResults(ws: TestWs, sid: string, n: number): Promise<void> {
  await vi.waitFor(() => expect(countResults(ws, sid)).toBeGreaterThanOrEqual(n));
}

async function createPlanner(ws: TestWs, extra: Record<string, unknown> = {}): Promise<string> {
  const ack = await ws.request("session.create", { role: "planner", repo: "sh", title: "Bug login", ...extra });
  expect(ack.type).toBe("ack");
  return ack.payload.result.session.session_id as string;
}

describe("Session Manager (planner)", () => {
  let h: AgentHarness;
  afterEach(async () => {
    await h?.dispose();
  });

  it("creates a planner session, chats over several turns in one process, and stores every event first", async () => {
    h = await startAgentHarness();
    const ws = await h.open();
    const sid = await createPlanner(ws);
    expect(h.driver.sessions).toHaveLength(0); // process chỉ spawn ở turn đầu
    const created = h.bridge.agents.sessions.get(sid);
    expect(created).toMatchObject({ role: "planner", repo: "sh", project_key: "SH", state: "starting", busy: false });

    const send1 = await ws.request("session.send", { session_id: sid, text: "Xin chào" });
    expect(send1.type).toBe("ack");
    expect(send1.payload.result.session.busy).toBe(true);
    await waitResults(ws, sid, 1);
    await ws.request("session.send", { session_id: sid, text: "Turn hai" });
    await waitResults(ws, sid, 2);

    expect(h.driver.sessions).toHaveLength(1);
    const fake = h.driver.last();
    expect(fake.sent).toEqual(["Xin chào", "Turn hai"]);
    expect(fake.options.cwd).toBe(h.repoDir);

    const session = h.bridge.agents.sessions.get(sid);
    expect(session).toMatchObject({ state: "active", claude_session_id: fake.claudeSessionId, busy: false });

    const history = h.bridge.eventLog.readSessionEvents({ session_id: sid });
    const kinds = history.map((r) => `${r.origin}:${(r.event as { type: string }).type}`);
    expect(kinds).toEqual([
      "user:user_text",
      "agent:system",
      "agent:assistant",
      "agent:result",
      "user:user_text",
      "agent:assistant",
      "agent:result",
    ]);
    expect(history[0]?.event).toEqual({ type: "user_text", text: "Xin chào" });
    // Mỗi session.event đẩy ra WS đều đã có id trong DB (ghi trước, đẩy sau).
    const pushedIds = ws.messages.filter((m) => m.type === "session.event").map((m) => m.payload.id as number);
    expect(pushedIds).toEqual(history.map((r) => r.id));
    // busy được đẩy qua session.updated: true khi gửi, false sau result.
    const busyFlags = ws.messages.filter((m) => m.type === "session.updated" && m.payload.session_id === sid).map((m) => m.payload.busy);
    expect(busyFlags).toContain(true);
    expect(busyFlags.at(-1)).toBe(false);
  });

  it("interrupts a running turn; the session keeps working afterwards", async () => {
    h = await startAgentHarness();
    const ws = await h.open();
    const sid = await createPlanner(ws);
    h.driver.script = async (turn) => {
      if (turn.text === "dài") {
        turn.say("đang làm...");
        await turn.waitForInterrupt();
        return;
      }
      turn.say(`ok: ${turn.text}`);
    };
    await ws.request("session.send", { session_id: sid, text: "dài" });
    await vi.waitFor(() => expect(h.bridge.agents.sessions.get(sid)?.busy).toBe(true));
    await ws.waitFor((m) => m.type === "session.event" && m.payload.event?.type === "assistant");

    const ack = await ws.request("session.interrupt", { session_id: sid });
    expect(ack.payload.result).toEqual({ interrupted: true });
    const result = await ws.waitFor(isResult(sid));
    expect(result.payload.event.subtype).toBe("error_during_execution");
    expect(h.driver.last().interrupts).toBe(1);
    await vi.waitFor(() => expect(h.bridge.agents.sessions.get(sid)?.busy).toBe(false));

    await ws.request("session.send", { session_id: sid, text: "tiếp" });
    await waitResults(ws, sid, 2);
    expect(h.driver.sessions).toHaveLength(1);
  });

  it("survives a backend restart: session detached, history intact, resume with the stored claude_session_id", async () => {
    h = await startAgentHarness();
    const ws = await h.open();
    const sid = await createPlanner(ws);
    await ws.request("session.send", { session_id: sid, text: "Turn một" });
    await waitResults(ws, sid, 1);
    const claudeId = h.driver.last().claudeSessionId;
    const before = h.bridge.eventLog.readSessionEvents({ session_id: sid });
    const dir = h.dir;
    await h.stop();

    // Backend chết đột ngột (không kịp đánh dấu): session vẫn `active` trong DB.
    const db = openDatabase(`${dir}/bridge.db`);
    db.prepare("UPDATE sessions SET state = 'active' WHERE session_id = ?").run(sid);
    db.close();

    h = await startAgentHarness({ dir });
    expect(h.bridge.agents.sessions.get(sid)).toMatchObject({ state: "detached", claude_session_id: claudeId, busy: false });
    const ws2 = await h.open();
    const snapshot = await ws2.waitFor((m) => m.type === "state.snapshot");
    expect(snapshot.payload.sessions.map((s: { session_id: string }) => s.session_id)).toContain(sid);

    const open = await ws2.request("session.open", { session_id: sid });
    expect(open.type).toBe("ack");
    const historyMsg = await ws2.waitFor((m) => m.type === "session.history");
    expect(historyMsg.payload.session_id).toBe(sid);
    expect(historyMsg.payload.events).toEqual(before);

    // `since` chỉ trả phần sau id đã có.
    const lastId = before.at(-1)?.id as number;
    const partial = await ws2.request("session.open", { session_id: sid, since: before[1]?.id });
    expect(partial.type).toBe("ack");
    const partialHistory = ws2.messages.filter((m) => m.type === "session.history").at(-1);
    expect(partialHistory?.payload.events.map((e: { id: number }) => e.id)).toEqual(before.slice(2).map((e) => e.id));

    expect(h.driver.sessions).toHaveLength(0); // resume lười
    await ws2.request("session.send", { session_id: sid, text: "Sau restart" });
    await waitResults(ws2, sid, 1);
    expect(h.driver.sessions).toHaveLength(1);
    expect(h.driver.last().options.resume).toBe(claudeId);
    const after = h.bridge.eventLog.readSessionEvents({ session_id: sid });
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.every((e, i) => i === 0 || e.id > (after[i - 1]?.id ?? 0))).toBe(true);
    expect(after.find((e) => e.id > lastId && e.origin === "user")?.event).toEqual({ type: "user_text", text: "Sau restart" });
    expect(h.bridge.agents.sessions.get(sid)?.state).toBe("active");
  });

  it("graceful shutdown leaves live sessions detached", async () => {
    h = await startAgentHarness();
    const ws = await h.open();
    const sid = await createPlanner(ws);
    await ws.request("session.send", { session_id: sid, text: "a" });
    await waitResults(ws, sid, 1);
    const dir = h.dir;
    await h.stop();
    h = await startAgentHarness({ dir });
    expect(h.bridge.agents.sessions.get(sid)?.state).toBe("detached");
  });

  it("only accepts repos from the whitelist; a cwd from the UI is ignored", async () => {
    h = await startAgentHarness();
    const ws = await h.open();
    const bad = await ws.request("session.create", { role: "planner", repo: "C:/Windows" });
    expect(bad.type).toBe("error");
    expect(bad.payload.code).toBe("FORBIDDEN");
    const badRole = await ws.request("session.create", { role: "orchestrator", repo: "sh" });
    expect(badRole.payload.code).toBe("BAD_REQUEST");

    const sid = await createPlanner(ws, { cwd: "C:/Windows", path: "C:/Windows" });
    await ws.request("session.send", { session_id: sid, text: "x" });
    await waitResults(ws, sid, 1);
    expect(h.driver.last().options.cwd).toBe(h.repoDir);
  });

  it("closes a session (no more turns) and rejects closing the orchestrator", async () => {
    h = await startAgentHarness();
    const ws = await h.open();
    const sid = await createPlanner(ws);
    await ws.request("session.send", { session_id: sid, text: "x" });
    await waitResults(ws, sid, 1);
    const closed = await ws.request("session.close", { session_id: sid });
    expect(closed.payload.result.session.state).toBe("closed");
    await vi.waitFor(() => expect(h.driver.last().closed).toBe(true));
    const send = await ws.request("session.send", { session_id: sid, text: "y" });
    expect(send.payload.code).toBe("CONFLICT");
    const list = await ws.request("session.list", { role: "planner" });
    expect(list.payload.result.sessions[0]).toMatchObject({ session_id: sid, state: "closed" });
    const missing = await ws.request("session.open", { session_id: "s-nope" });
    expect(missing.payload.code).toBe("NOT_FOUND");
  });

  it("enforces the planner tool allowlist at every layer", async () => {
    h = await startAgentHarness({
      config: { planner: { allowed_tools: ["mcp__jira__jira_search", "mcp__jira__jira_get_*"], mcp_servers: { jira: { command: "uvx", args: ["mcp-atlassian"] } } } },
    });
    const ws = await h.open();
    const sid = await createPlanner(ws);
    const outcomes: Record<string, FakeToolOutcome> = {};
    h.driver.script = async (turn) => {
      outcomes.bash = await turn.useTool("Bash", { command: "rm -rf /" });
      outcomes.edit = await turn.useTool("Edit", { file_path: "a.ts" });
      outcomes.jiraWrite = await turn.useTool("mcp__jira__jira_update_issue", { issue_key: "SH-1" });
      outcomes.other = await turn.useTool("mcp__github__create_pr", {});
      outcomes.read = await turn.useTool("Read", { file_path: "src/a.ts" });
      outcomes.readOutside = await turn.useTool("Read", { file_path: "C:/Users/x/.ssh/id_rsa" }, undefined, {
        blockedPath: "C:/Users/x/.ssh/id_rsa",
      });
      outcomes.search = await turn.useTool("mcp__jira__jira_search", { jql: "project = SH" });
      outcomes.getIssue = await turn.useTool("mcp__jira__jira_get_issue", { issue_key: "SH-1" });
    };
    await ws.request("session.send", { session_id: sid, text: "go" });
    await waitResults(ws, sid, 1);

    for (const k of ["bash", "edit", "jiraWrite", "other"]) {
      expect(outcomes[k], k).toMatchObject({ allowed: false, decided_by: "hook" });
    }
    expect(outcomes.read).toMatchObject({ allowed: true, decided_by: "auto" });
    expect(outcomes.readOutside).toMatchObject({ allowed: false, decided_by: "hook" });
    expect(outcomes.search).toMatchObject({ allowed: true, decided_by: "preapproved" });
    expect(outcomes.getIssue).toMatchObject({ allowed: true, decided_by: "canUseTool" });

    const opts = h.driver.last().options;
    expect(opts).toMatchObject({
      tools: ["Read", "Grep", "Glob", "ToolSearch"],
      allowedTools: ["mcp__jira__jira_search"],
      permissionMode: "default",
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { jira: { command: "uvx", args: ["mcp-atlassian"] } },
    });
    // canUseTool từ chối cả khi một allow rule (setting_sources) cho tool đi qua hook.
    const direct = await opts.canUseTool?.("Write", {}, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
    expect(direct).toMatchObject({ behavior: "deny" });
    // Tool bị từ chối hiện thành tool_result lỗi trong luồng session.
    const denied = h.bridge.eventLog
      .readSessionEvents({ session_id: sid })
      .filter((r) => JSON.stringify(r.event).includes('"is_error":true'));
    expect(denied.length).toBe(5);
  });

  it("tracks rate limit events in system.status", async () => {
    h = await startAgentHarness();
    const ws = await h.open();
    const sid = await createPlanner(ws);
    const resetsAt = Math.floor(h.clock.now() / 1000) + 3600;
    h.driver.script = (turn) => {
      turn.session.emitRateLimit({ status: "rejected", resetsAt, utilization: 1 });
    };
    await ws.request("session.send", { session_id: sid, text: "x" });
    const status = await ws.waitFor((m) => m.type === "system.status" && m.payload.seat_usage !== undefined);
    const iso = new Date(resetsAt * 1000).toISOString();
    expect(status.payload).toMatchObject({ seat_usage: { status: "rejected", resets_at: iso, utilization: 1 }, rate_limited_until: iso });

    // Dạng CLI 2.1.322 thật gửi: utilization nằm trong unifiedWindows; status allowed thì không còn bị chặn.
    h.driver.script = (turn) => {
      turn.session.emitRateLimit({
        status: "allowed",
        resetsAt,
        rateLimitType: "five_hour",
        unifiedWindows: { five_hour: { utilization: 0.34, resetsAt, status: "allowed" } },
      });
    };
    await ws.request("session.send", { session_id: sid, text: "y" });
    await vi.waitFor(() => expect(h.bridge.status.get().seat_usage).toEqual({ status: "allowed", resets_at: iso, utilization: 0.34 }));
    expect(h.bridge.status.get().rate_limited_until).toBeUndefined();
  });
});

describe("Claude auth and tool policy", () => {
  it("subscription mode strips API credentials; api_key mode requires ANTHROPIC_API_KEY", () => {
    const env = { PATH: "p", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t" };
    const sub = buildClaudeEnv("subscription", env, "test/1");
    for (const name of API_CREDENTIAL_ENV_VARS) expect(sub[name]).toBeUndefined();
    expect(sub).toMatchObject({ PATH: "p", CLAUDE_AGENT_SDK_CLIENT_APP: "test/1" });
    expect(buildClaudeEnv("api_key", env, "test/1").ANTHROPIC_API_KEY).toBe("k");
    expect(() => buildClaudeEnv("api_key", { PATH: "p" }, "test/1")).toThrow(ConfigError);
  });

  it("fails at startup in api_key mode without a key", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { startBridge, tempDir } = await import("./helpers.js");
    const dir = tempDir();
    try {
      await expect(startBridge({ dir, config: { claude_auth_mode: "api_key" } })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      removeDir(dir);
    }
  });

  it("matches exact names and trailing wildcards only", () => {
    expect(matchesToolPattern("mcp__jira__get_*", "mcp__jira__get_issue")).toBe(true);
    expect(matchesToolPattern("mcp__jira__get_*", "mcp__jira__create_issue")).toBe(false);
    expect(matchesToolPattern("Read", "ReadX")).toBe(false);
    const policy = new ToolPolicy(["Read", "mcp__a__x", "mcp__a__y*", "Grep"]);
    expect(policy.builtinTools()).toEqual(["Read", "Grep"]);
    expect(policy.preapprovedMcpTools(() => false)).toEqual(["mcp__a__x"]);
    expect(policy.preapprovedMcpTools((n) => n === "mcp__a__x")).toEqual([]);
  });
});
