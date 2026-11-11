// Phase 5 (mục 18): trigger được gộp theo debounce, xếp hàng khi orchestrator đang giữa turn; tick; ticket.created
// không có label agent không đánh thức; orchestrator chết thì tự resume với cùng claude_session_id.
import { BUS_MCP_SERVER_NAME, ORCHESTRATOR_TOOLS, busToolFullName, formatWakeTurn, parseWakeTurn } from "@claude-bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeClaudeSession } from "../src/claude/fakeDriver.js";
import { type AgentHarness, startAgentHarness } from "./agentHarness.js";
import { registerRunners, settle } from "./helpers.js";

const DEBOUNCE_MS = 10_000;
const TICK_MS = 10 * 60_000;

function orchestratorFake(h: AgentHarness): FakeClaudeSession {
  const fake = h.driver.sessions.filter((s) => s.options.cwd === h.orchestratorDir).at(-1);
  if (!fake) throw new Error("orchestrator not started");
  return fake;
}

function wakeTurns(fake: FakeClaudeSession): unknown[][] {
  return fake.sent.map((t) => parseWakeTurn(t)).filter((e): e is NonNullable<typeof e> => e !== null);
}

describe("Wake Dispatcher + orchestrator", () => {
  let h: AgentHarness;
  afterEach(async () => {
    await h?.dispose();
  });

  it("autostarts the orchestrator with the bus MCP server and the orchestrator allowlist", async () => {
    h = await startAgentHarness({ withOrchestrator: true });
    const fake = orchestratorFake(h);
    expect(h.bridge.status.get()).toMatchObject({ project_key: "SH", orchestrator: "alive" });
    const opts = fake.options;
    expect(opts.mcpServers?.[BUS_MCP_SERVER_NAME]).toEqual({
      type: "http",
      url: h.bridge.mcpUrl(),
      headers: { Authorization: `Bearer ${h.bridge.tokens.getOrchestratorToken()}` },
      alwaysLoad: true,
    });
    expect(opts.tools).toEqual(["ToolSearch"]);
    expect(opts.allowedTools).toEqual(ORCHESTRATOR_TOOLS.map((t) => busToolFullName(t)));
    const append = (opts.systemPrompt as { append: string }).append;
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
    h = await startAgentHarness({ withOrchestrator: true });
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
    const session = h.bridge.agents.orchestrators.sessionFor("SH");
    const records = eventLog.readSessionEvents({ session_id: session?.session_id as string });
    expect(records[0]).toMatchObject({ origin: "system", event: { type: "user_text", text: fake.sent[0] } });
  });

  it("ticket.created without the agent label does not wake the orchestrator", async () => {
    h = await startAgentHarness({ withOrchestrator: true });
    const fake = orchestratorFake(h);
    h.bridge.bus.emitTicketCreated({ ticket_key: "SH-200", session_id: "s-1", labels: ["backend"] });
    expect(h.bridge.agents.wake.pendingEvents("SH")).toEqual([]);
    h.timers.advance(DEBOUNCE_MS * 2);
    await settle();
    expect(fake.sent).toHaveLength(0);
  });

  it("queues triggers while the orchestrator is mid-turn and sends them merged after the turn's result", async () => {
    h = await startAgentHarness({ withOrchestrator: true });
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
    h = await startAgentHarness({ withOrchestrator: true });
    const fake = orchestratorFake(h);
    const ws = await h.open();
    const sid = h.bridge.agents.orchestrators.sessionFor("SH")?.session_id as string;
    await ws.request("session.send", { session_id: sid, text: "Giao SH-129 cho w-sh-01" });
    await vi.waitFor(() => expect(fake.sent).toEqual(["Giao SH-129 cho w-sh-01"]));
    const first = h.bridge.eventLog.readSessionEvents({ session_id: sid })[0];
    expect(first?.origin).toBe("user");
  });

  it("fires a tick every orch_tick_minutes", async () => {
    h = await startAgentHarness({ withOrchestrator: true });
    const fake = orchestratorFake(h);
    h.timers.advance(TICK_MS);
    await settle();
    expect(fake.sent).toHaveLength(0);
    h.timers.advance(DEBOUNCE_MS);
    await vi.waitFor(() => expect(wakeTurns(fake)).toEqual([[{ type: "tick" }]]));
  });

  it("respawns a dead orchestrator with resume of the same claude_session_id and reports status transitions", async () => {
    h = await startAgentHarness({ withOrchestrator: true });
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
    h = await startAgentHarness({ withOrchestrator: true, config: { orchestrator_autostart: false } });
    expect(h.driver.sessions).toHaveLength(0);
    expect(h.bridge.status.get().orchestrator).toBe("stopped");
    const ws = await h.open();
    await ws.request("project.select", { project_key: "SH" });
    expect(h.driver.sessions).toHaveLength(1);
    expect(h.bridge.status.get().orchestrator).toBe("alive");
  });
});
