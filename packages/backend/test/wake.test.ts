// Phase 5 (mục 18): trigger được gộp theo debounce, xếp hàng khi orchestrator đang giữa turn; tick; ticket.created
// không có label agent không đánh thức; orchestrator chết thì tự resume với cùng claude_session_id.
// wake_mode manual (mặc định): chỉ task.completed / task.failed đánh thức; lời chào khi backend khởi động.
import {
  BUS_MCP_SERVER_NAME,
  ORCHESTRATOR_TOOLS,
  type SessionEventRecord,
  busToolFullName,
  formatWakeTurn,
  parseWakeTurn,
} from "@claude-bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeClaudeSession } from "../src/claude/fakeDriver.js";
import { ORCHESTRATOR_PROMPT_AUTO } from "../src/sessions/profiles.js";
import { type AgentHarness, startAgentHarness } from "./agentHarness.js";
import { registerRunners, settle } from "./helpers.js";

const DEBOUNCE_MS = 10_000;
const TICK_MS = 10 * 60_000;
const AUTO = { wake_mode: "auto" } as const;

function orchestratorFake(h: AgentHarness): FakeClaudeSession {
  const fake = h.driver.sessions.filter((s) => s.options.cwd === h.orchestratorDir).at(-1);
  if (!fake) throw new Error("orchestrator not started");
  return fake;
}

function wakeTurns(fake: FakeClaudeSession): unknown[][] {
  return fake.sent.map((t) => parseWakeTurn(t)).filter((e): e is NonNullable<typeof e> => e !== null);
}

function orchestratorRecords(h: AgentHarness): SessionEventRecord[] {
  const sid = h.bridge.agents.orchestrators.sessionFor("SH")?.session_id as string;
  return h.bridge.eventLog.readSessionEvents({ session_id: sid });
}

function eventType(r: SessionEventRecord): string | undefined {
  return (r.event as { type?: string } | null)?.type;
}

function welcomes(h: AgentHarness): SessionEventRecord[] {
  return orchestratorRecords(h).filter((r) => eventType(r) === "bridge_welcome");
}

function appendOf(fake: FakeClaudeSession): string {
  return (fake.options.systemPrompt as { append: string }).append;
}

describe("Wake Dispatcher + orchestrator (wake_mode auto)", () => {
  let h: AgentHarness;
  afterEach(async () => {
    await h?.dispose();
  });

  it("autostarts the orchestrator with the bus MCP server and the orchestrator allowlist", async () => {
    h = await startAgentHarness({ withOrchestrator: true, config: AUTO });
    const fake = orchestratorFake(h);
    expect(h.bridge.status.get()).toMatchObject({ project_key: "SH", orchestrator: "alive" });
    const opts = fake.options;
    expect(opts.mcpServers?.[BUS_MCP_SERVER_NAME]).toEqual({
      type: "http",
      url: h.bridge.mcpUrl(),
      headers: { Authorization: `Bearer ${h.bridge.tokens.getOrchestratorToken("SH")}` },
      alwaysLoad: true,
    });
    expect(opts.tools).toEqual(["ToolSearch"]);
    expect(opts.allowedTools).toEqual(ORCHESTRATOR_TOOLS.map((t) => busToolFullName(t)));
    const append = appendOf(fake);
    expect(append).toBe(ORCHESTRATOR_PROMPT_AUTO.replaceAll("{PROJECT}", "SH"));
    expect(append).toContain(busToolFullName("assign_task"));
    expect(append).toContain("[bridge-event]");
    const deny = await opts.canUseTool?.("Bash", {}, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
    expect(deny).toMatchObject({ behavior: "deny" });
    const jiraCreate = await opts.canUseTool?.("mcp__jira__jira_create_issue", {}, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
    expect(jiraCreate).toMatchObject({ behavior: "deny" });

    const ws = await h.open();
    const snap = await ws.waitFor((m) => m.type === "state.snapshot");
    expect(snap.payload.sessions).toEqual([expect.objectContaining({ role: "orchestrator", project_key: "SH" })]);
    const sel = await ws.request("project.select", { project_key: "SH" });
    expect(sel.payload.result.orchestrator_session).toMatchObject({ role: "orchestrator", project_key: "SH" });
    expect((await ws.request("project.select", { project_key: "XX" })).payload.code).toBe("NOT_FOUND");
    expect((await ws.request("session.close", { session_id: sel.payload.result.orchestrator_session.session_id })).payload.code).toBe(
      "FORBIDDEN",
    );
  });

  it("coalesces system triggers inside the debounce window into one [bridge-event] turn (origin system)", async () => {
    h = await startAgentHarness({ withOrchestrator: true, config: AUTO });
    const fake = orchestratorFake(h);
    const { bus, eventLog } = h.bridge;
    bus.emitTicketCreated({ ticket_key: "SH-131", session_id: "s-1", labels: ["agent"] });
    h.timers.advance(3_000);
    eventLog.appendBusEvent({ type: "task.completed", task_id: "t-84", ticket_key: "SH-124", payload: {} });
    eventLog.appendBusEvent({ type: "task.failed", task_id: "t-85", ticket_key: "SH-125", payload: { category: "build_failed" } });
    await registerRunners(h.bridge, "w-sh-01");
    // Event của project khác bị bỏ qua.
    eventLog.appendBusEvent({ type: "task.completed", task_id: "t-99", ticket_key: "OT-1", payload: {} });
    h.timers.advance(DEBOUNCE_MS - 3_001);
    await settle();
    expect(fake.sent).toHaveLength(0);

    h.timers.advance(1);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toBe(
      formatWakeTurn([
        { type: "ticket.created", ticket_key: "SH-131" },
        { type: "task.completed", task_id: "t-84", ticket_key: "SH-124" },
        { type: "task.failed", task_id: "t-85", ticket_key: "SH-125", category: "build_failed" },
        { type: "worker.registered", worker_id: "w-sh-01" },
      ]),
    );
    const turn = orchestratorRecords(h).find((r) => eventType(r) === "user_text");
    expect(turn).toMatchObject({ origin: "system", event: { type: "user_text", text: fake.sent[0] } });
  });

  it("ticket.created without the agent label does not wake the orchestrator", async () => {
    h = await startAgentHarness({ withOrchestrator: true, config: AUTO });
    const fake = orchestratorFake(h);
    h.bridge.bus.emitTicketCreated({ ticket_key: "SH-200", session_id: "s-1", labels: ["backend"] });
    expect(h.bridge.agents.wake.pendingEvents("SH")).toEqual([]);
    h.timers.advance(DEBOUNCE_MS * 2);
    await settle();
    expect(fake.sent).toHaveLength(0);
  });

  it("queues triggers while the orchestrator is mid-turn and sends them merged after the turn's result", async () => {
    h = await startAgentHarness({ withOrchestrator: true, config: AUTO });
    const fake = orchestratorFake(h);
    let release: (() => void) | null = null;
    h.driver.script = async (turn) => {
      if (turn.text.includes("SH-1\"")) await new Promise<void>((resolve) => (release = resolve));
      turn.say("ok");
    };
    const { bus, eventLog } = h.bridge;
    bus.emitTicketCreated({ ticket_key: "SH-1", session_id: "s-1", labels: ["agent"] });
    h.timers.advance(DEBOUNCE_MS);
    await vi.waitFor(() => expect(release).not.toBeNull());
    expect(h.bridge.agents.orchestrators.isReady("SH")).toBe(false);

    eventLog.appendBusEvent({ type: "task.completed", task_id: "t-2", ticket_key: "SH-2", payload: {} });
    h.timers.advance(DEBOUNCE_MS);
    eventLog.appendBusEvent({ type: "task.failed", task_id: "t-3", ticket_key: "SH-3", payload: { category: "blocked" } });
    h.timers.advance(DEBOUNCE_MS);
    await settle();
    expect(fake.sent).toHaveLength(1);
    expect(h.bridge.agents.wake.pendingEvents("SH")).toHaveLength(2);

    (release as unknown as () => void)();
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    expect(wakeTurns(fake)[1]).toEqual([
      { type: "task.completed", task_id: "t-2", ticket_key: "SH-2" },
      { type: "task.failed", task_id: "t-3", ticket_key: "SH-3", category: "blocked" },
    ]);
  });

  it("user messages are sent immediately, not debounced", async () => {
    h = await startAgentHarness({ withOrchestrator: true, config: AUTO });
    const fake = orchestratorFake(h);
    const ws = await h.open();
    const sid = h.bridge.agents.orchestrators.sessionFor("SH")?.session_id as string;
    await ws.request("session.send", { session_id: sid, text: "Giao SH-129 cho w-sh-01" });
    await vi.waitFor(() => expect(fake.sent).toEqual(["Giao SH-129 cho w-sh-01"]));
    const turn = orchestratorRecords(h).find((r) => eventType(r) === "user_text");
    expect(turn?.origin).toBe("user");
  });

  it("fires a tick every orch_tick_minutes", async () => {
    h = await startAgentHarness({ withOrchestrator: true, config: AUTO });
    const fake = orchestratorFake(h);
    h.timers.advance(TICK_MS);
    await settle();
    expect(fake.sent).toHaveLength(0);
    h.timers.advance(DEBOUNCE_MS);
    await vi.waitFor(() => expect(wakeTurns(fake)).toEqual([[{ type: "tick" }]]));
  });

  it("respawns a dead orchestrator with resume of the same claude_session_id and reports status transitions", async () => {
    h = await startAgentHarness({ withOrchestrator: true, config: AUTO });
    const ws = await h.open();
    const fake = orchestratorFake(h);
    const sid = h.bridge.agents.orchestrators.sessionFor("SH")?.session_id as string;
    await ws.request("session.send", { session_id: sid, text: "hello" });
    await vi.waitFor(() => expect(h.bridge.agents.sessions.get(sid)?.claude_session_id).toBe(fake.claudeSessionId));
    await vi.waitFor(() => expect(h.bridge.agents.sessions.get(sid)?.busy).toBe(false));

    fake.crash();
    await ws.waitFor((m) => m.type === "system.status" && m.payload.orchestrator === "restarting");
    expect(h.bridge.status.get().orchestrator).toBe("restarting");
    expect(h.driver.sessions).toHaveLength(1);

    const restartedAt = ws.messages.findIndex((m) => m.type === "system.status" && m.payload.orchestrator === "restarting");
    h.timers.advance(1_000);
    await vi.waitFor(() =>
      expect(ws.messages.slice(restartedAt).some((m) => m.type === "system.status" && m.payload.orchestrator === "alive")).toBe(true),
    );
    const respawned = orchestratorFake(h);
    expect(respawned).not.toBe(fake);
    expect(respawned.options.resume).toBe(fake.claudeSessionId);
    expect(h.bridge.agents.sessions.get(sid)).toMatchObject({ claude_session_id: fake.claudeSessionId });

    // Turn đang chạy lúc chết đã mất: một tick nhắc orchestrator dựng lại toàn cảnh.
    h.timers.advance(DEBOUNCE_MS);
    await vi.waitFor(() => expect(wakeTurns(respawned)).toEqual([[{ type: "tick" }]]));
  });

  it("gives up after too many consecutive failures (dead), with exponential backoff", async () => {
    h = await startAgentHarness({
      withOrchestrator: true,
      config: AUTO,
      restartPolicy: { baseDelayMs: 1_000, maxDelayMs: 60_000, maxConsecutiveFailures: 2, stableRunMs: 300_000 },
    });
    orchestratorFake(h).crash();
    await vi.waitFor(() => expect(h.bridge.status.get().orchestrator).toBe("restarting"));
    h.timers.advance(1_000);
    await vi.waitFor(() => expect(h.driver.sessions).toHaveLength(2));
    orchestratorFake(h).crash();
    await vi.waitFor(() => expect(h.bridge.status.get().orchestrator).toBe("restarting"));
    h.timers.advance(1_999);
    await settle();
    expect(h.driver.sessions).toHaveLength(2); // backoff lần hai = 2 s
    h.timers.advance(1);
    await vi.waitFor(() => expect(h.driver.sessions).toHaveLength(3));
    orchestratorFake(h).crash();
    await vi.waitFor(() => expect(h.bridge.status.get().orchestrator).toBe("dead"));
    h.timers.advance(120_000);
    await settle();
    expect(h.driver.sessions).toHaveLength(3);
    // Trigger không được giữ cho orchestrator đã dead.
    h.bridge.bus.emitTicketCreated({ ticket_key: "SH-5", session_id: "s", labels: ["agent"] });
    expect(h.bridge.agents.wake.pendingEvents("SH")).toEqual([]);
  });

  it("with orchestrator_autostart=false the orchestrator starts when its project is selected", async () => {
    h = await startAgentHarness({ withOrchestrator: true, config: { ...AUTO, orchestrator_autostart: false } });
    expect(h.driver.sessions).toHaveLength(0);
    expect(h.bridge.status.get().orchestrator).toBe("stopped");
    const ws = await h.open();
    await ws.request("project.select", { project_key: "SH" });
    expect(h.driver.sessions).toHaveLength(1);
    expect(h.bridge.status.get().orchestrator).toBe("alive");
  });
});

describe("wake_mode manual (default)", () => {
  let h: AgentHarness;
  afterEach(async () => {
    await h?.dispose();
  });

  it("runner registration, new agent tickets and the periodic tick never wake the orchestrator", async () => {
    h = await startAgentHarness({ withOrchestrator: true });
    expect(h.bridge.config.wake_mode).toBe("manual");
    const fake = orchestratorFake(h);
    await registerRunners(h.bridge, "w-sh-01", "w-sh-02");
    h.bridge.bus.emitTicketCreated({ ticket_key: "SH-131", session_id: "s-1", labels: ["agent"] });
    expect(h.bridge.agents.wake.pendingEvents("SH")).toEqual([]);
    h.timers.advance(TICK_MS * 3 + DEBOUNCE_MS);
    await settle();
    expect(fake.sent).toEqual([]);
    expect(orchestratorRecords(h).filter((r) => eventType(r) === "user_text")).toEqual([]);
  });

  it("still forwards task.completed / task.failed as one [bridge-event] turn", async () => {
    h = await startAgentHarness({ withOrchestrator: true });
    const fake = orchestratorFake(h);
    const { eventLog } = h.bridge;
    eventLog.appendBusEvent({ type: "task.completed", task_id: "t-84", ticket_key: "SH-124", payload: {} });
    eventLog.appendBusEvent({ type: "task.failed", task_id: "t-85", ticket_key: "SH-125", payload: { category: "build_failed" } });
    h.timers.advance(DEBOUNCE_MS);
    await vi.waitFor(() =>
      expect(wakeTurns(fake)).toEqual([
        [
          { type: "task.completed", task_id: "t-84", ticket_key: "SH-124" },
          { type: "task.failed", task_id: "t-85", ticket_key: "SH-125", category: "build_failed" },
        ],
      ]),
    );
  });

  it("does not queue a tick after a crash-restart", async () => {
    h = await startAgentHarness({ withOrchestrator: true });
    const fake = orchestratorFake(h);
    fake.crash();
    await vi.waitFor(() => expect(h.bridge.status.get().orchestrator).toBe("restarting"));
    h.timers.advance(1_000);
    await vi.waitFor(() => expect(h.bridge.status.get().orchestrator).toBe("alive"));
    const respawned = orchestratorFake(h);
    expect(respawned).not.toBe(fake);
    expect(h.bridge.agents.wake.pendingEvents("SH")).toEqual([]);
    h.timers.advance(DEBOUNCE_MS * 2);
    await settle();
    expect(respawned.sent).toEqual([]);
  });

  it("uses the manual orchestrator prompt: acts only on user requests, no eager Jira scan", async () => {
    h = await startAgentHarness({ withOrchestrator: true });
    const append = appendOf(orchestratorFake(h));
    expect(append).toContain("Chế độ thủ công");
    expect(append).toContain("không bao giờ tự chọn hay tự giao ticket");
    expect(append).toContain("làm lần lượt SH-1, SH-2");
    expect(append).toContain(busToolFullName("assign_task"));
    expect(append).toContain(busToolFullName("list_workers"));
    expect(append).not.toContain("{PROJECT}");
    expect(append).not.toContain("quyết định có giao việc hay không");
  });
});

describe("bridge welcome", () => {
  let h: AgentHarness;
  afterEach(async () => {
    await h?.dispose();
  });

  it("is recorded once per backend process (origin system), without a Claude turn, and not on crash-restart", async () => {
    const first = await startAgentHarness({ withOrchestrator: true });
    h = first; // dọn thư mục nếu test dừng giữa chừng
    const fake = orchestratorFake(first);
    const records = orchestratorRecords(first);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ origin: "system", event: { type: "bridge_welcome" } });
    const text = (records[0]?.event as { text: string }).text;
    expect(text).toContain("project `SH`");
    expect(text).toContain("Chế độ thủ công");
    expect(text).toContain(`- \`sh\` · ${first.repoDir}`);
    expect(text).toContain("tab Workers");
    expect(text).toContain("- Giao SH-123 cho worker rảnh");
    expect(text).toContain("- Tình hình các worker?");
    expect(fake.sent).toEqual([]);

    fake.crash();
    await vi.waitFor(() => expect(first.bridge.status.get().orchestrator).toBe("restarting"));
    first.timers.advance(1_000);
    await vi.waitFor(() => expect(first.bridge.status.get().orchestrator).toBe("alive"));
    expect(welcomes(first)).toHaveLength(1);
    await first.stop();

    // Backend chạy lại cùng DB: cùng session orchestrator, thêm một lời chào mới.
    h = await startAgentHarness({ dir: first.dir, withOrchestrator: true });
    expect(welcomes(h)).toHaveLength(2);
    expect(orchestratorFake(h).sent).toEqual([]);
  });

  it("describes auto mode when wake_mode is auto", async () => {
    h = await startAgentHarness({ withOrchestrator: true, config: AUTO });
    const text = (welcomes(h)[0]?.event as { text: string }).text;
    expect(text).toContain("Chế độ tự động");
    expect(text).toContain("mỗi 10 phút");
  });

  it("with orchestrator_autostart=false is recorded when the orchestrator first starts, before the first message", async () => {
    h = await startAgentHarness({ withOrchestrator: true, config: { orchestrator_autostart: false } });
    expect(h.bridge.agents.orchestrators.sessionFor("SH")).toBeNull();
    const ws = await h.open();
    const sel = await ws.request("project.select", { project_key: "SH" });
    const sid = sel.payload.result.orchestrator_session.session_id as string;
    expect(welcomes(h)).toHaveLength(1);
    await ws.request("session.send", { session_id: sid, text: "Tình hình các worker?" });
    await vi.waitFor(() => expect(orchestratorFake(h).sent).toEqual(["Tình hình các worker?"]));
    expect(orchestratorRecords(h).slice(0, 2).map(eventType)).toEqual(["bridge_welcome", "user_text"]);
  });

  it("lists only this project's repos and says so when there are none", async () => {
    h = await startAgentHarness({
      withOrchestrator: true,
      config: { repos: [{ name: "other", path: "D:/repos/other", project_key: "OT" }] },
    });
    const text = (welcomes(h)[0]?.event as { text: string }).text;
    expect(text).not.toContain("other");
    expect(text).toContain("Chưa có repo nào gắn project SH");
  });
});
