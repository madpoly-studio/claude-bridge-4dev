// Review fixes: stale claude_session_id recovery, latest-N history with `truncated`, wake retry after a failed flush,
// messages to a closing / ended session are rejected instead of dropped.
import { type WakeEvent, parseWakeTurn } from "@claude-bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventLog } from "../src/events/eventLog.js";
import type { Logger } from "../src/util/logger.js";
import { type WakeTarget, WakeDispatcher } from "../src/wake/wakeDispatcher.js";
import { type AgentHarness, startAgentHarness } from "./agentHarness.js";
import { FakeClock, FakeTimers, settle } from "./helpers.js";

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

describe("session robustness", () => {
  let h: AgentHarness;
  afterEach(async () => {
    await h?.dispose();
  });

  it("M1: a resume that dies before init clears claude_session_id and the orchestrator recovers with a fresh conversation", async () => {
    h = await startAgentHarness({ withOrchestrator: true });
    const orchestrators = h.bridge.agents.orchestrators;
    const sessions = h.bridge.agents.sessions;
    const sid = orchestrators.sessionFor("SH")?.session_id as string;
    const first = h.driver.last();
    sessions.sendText(sid, "hello", "user");
    await vi.waitFor(() => expect(sessions.get(sid)?.claude_session_id).toBe(first.claudeSessionId));
    await vi.waitFor(() => expect(sessions.get(sid)?.busy).toBe(false));

    // Process chết sau init: resume như cũ.
    first.crash();
    await vi.waitFor(() => expect(orchestrators.health("SH")).toBe("restarting"));
    h.timers.advance(1_000);
    await vi.waitFor(() => expect(h.driver.sessions).toHaveLength(2));
    const resumed = h.driver.last();
    expect(resumed.options.resume).toBe(first.claudeSessionId);

    // Transcript đã bị dọn: CLI thoát lỗi trước init.
    resumed.crash(new Error(`No conversation found with session ID: ${first.claudeSessionId}`));
    await vi.waitFor(() => expect(sessions.get(sid)?.claude_session_id).toBeNull());
    expect(sessions.get(sid)?.state).toBe("detached");
    const notices = sessions
      .history(sid, 0)
      .events.filter((r) => r.origin === "system" && (r.event as { type: string }).type === "bridge_notice");
    expect(notices.map((r) => (r.event as { message: string }).message)).toContainEqual(expect.stringContaining("could not resume"));

    await vi.waitFor(() => expect(orchestrators.health("SH")).toBe("restarting"));
    h.timers.advance(2_000);
    await vi.waitFor(() => expect(h.driver.sessions).toHaveLength(3));
    const fresh = h.driver.last();
    expect(fresh.options.resume).toBeUndefined();
    expect(orchestrators.health("SH")).toBe("alive");
    sessions.sendText(sid, "again", "user");
    await vi.waitFor(() => expect(sessions.get(sid)?.claude_session_id).toBe(fresh.claudeSessionId));
  });

  it("M4: session.open without since returns the latest events in ascending order, flagged as truncated", async () => {
    h = await startAgentHarness();
    const ws = await h.open();
    const ack = await ws.request("session.create", { role: "planner", repo: "sh" });
    const sid = ack.payload.result.session.session_id as string;
    const total = 5_003;
    const inputs = Array.from({ length: total }, (_, i) => ({ session_id: sid, origin: "agent" as const, event: { n: i } }));
    h.bridge.eventLog.appendSessionEvents(inputs);

    const open = await ws.request("session.open", { session_id: sid });
    expect(open.type).toBe("ack");
    const history = ws.messages.filter((m) => m.type === "session.history").at(-1)!.payload;
    expect(history.events).toHaveLength(5_000);
    expect(history.truncated).toBe(true);
    expect(history.events[0].event).toEqual({ n: 3 });
    expect(history.events.at(-1).event).toEqual({ n: total - 1 });
    expect(history.first_id).toBe(history.events[0].id);
    const ids = history.events.map((r: { id: number }) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    // since gần cuối: không thiếu gì, truncated = false.
    const lastId = history.events.at(-1).id as number;
    await ws.request("session.open", { session_id: sid, since: lastId - 2 });
    const tail = ws.messages.filter((m) => m.type === "session.history").at(-1)!.payload;
    expect(tail).toMatchObject({ truncated: false, first_id: lastId - 1 });
    expect(tail.events.map((r: { id: number }) => r.id)).toEqual([lastId - 1, lastId]);

    const direct = h.bridge.eventLog.readSessionHistory({ session_id: sid, since: 0, limit: 2 });
    expect(direct).toMatchObject({ truncated: true, events: [{ id: lastId - 1 }, { id: lastId }] });
    expect(h.bridge.eventLog.readSessionHistory({ session_id: "s-none" })).toEqual({ events: [], truncated: false });
  });

  it("L4: a message to a closing or ended session is rejected with CONFLICT, not dropped", async () => {
    h = await startAgentHarness();
    const sessions = h.bridge.agents.sessions;
    const ws = await h.open();
    const create = async (): Promise<string> =>
      (await ws.request("session.create", { role: "planner", repo: "sh" })).payload.result.session.session_id as string;

    const closing = await create();
    sessions.sendText(closing, "one", "user");
    sessions.close(closing);
    // Runtime vẫn còn (process chưa thoát hẳn) nhưng đang đóng.
    expect(() => sessions.sendText(closing, "two", "user")).toThrow(expect.objectContaining({ code: "CONFLICT" }));

    const crashed = await create();
    sessions.sendText(crashed, "one", "user");
    await vi.waitFor(() => expect(sessions.isBusy(crashed)).toBe(false));
    const before = sessions.history(crashed, 0).events.length;
    h.driver.last().crash();
    // Cùng tick: runtime chưa bị gỡ, push vào process đã chết trả false.
    expect(() => sessions.sendText(crashed, "two", "user")).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(sessions.isBusy(crashed)).toBe(false);
    expect(sessions.history(crashed, 0).events.filter((r) => (r.event as { text?: string }).text === "two")).toEqual([]);
    await settle();
    expect(sessions.history(crashed, 0).events.length).toBeGreaterThan(before); // chỉ có notice process chết
  });
});

describe("L3: wake events after a failed flush", () => {
  it("retries on its own instead of waiting for an idle signal that may never come", () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const sent: WakeEvent[][] = [];
    let failures = 1;
    const target: WakeTarget = {
      projects: () => ["SH"],
      acceptsWake: () => true,
      isReady: () => true,
      sendSystemTurn: (_project, text) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("orchestrator session is closing");
        }
        sent.push(parseWakeTurn(text) ?? []);
      },
      onIdle: () => () => undefined,
      onRestarted: () => () => undefined,
      onHealthChanged: () => () => undefined,
    };
    const wake = new WakeDispatcher({ eventLog: {} as EventLog, target, timers, debounceMs: 10_000, tickMs: 600_000, mode: "auto", log: silentLog });

    wake.enqueue("SH", { type: "tick" });
    timers.advance(10_000);
    expect(sent).toEqual([]);
    expect(wake.pendingEvents("SH")).toEqual([{ type: "tick" }]);
    // Event mới không mở cửa sổ (không phải event đầu tiên) — trước đây cả hai kẹt tại đây.
    wake.enqueue("SH", { type: "ticket.created", ticket_key: "SH-1" });
    timers.advance(10_000);
    expect(sent).toEqual([[{ type: "tick" }, { type: "ticket.created", ticket_key: "SH-1" }]]);
    expect(wake.pendingEvents("SH")).toEqual([]);
    wake.stop();
  });
});
