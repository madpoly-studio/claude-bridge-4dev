import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_SPOT_DELAY_MS } from "../components/office/constants";
import { OFFICE_LAYOUT } from "../components/office/model/layout";
import { planRoute, segmentMs } from "../components/office/model/route";
import { createDemoState } from "../demo/fixtures";
import { DEMO_REPLY_DELAY_MS, DemoBridgeService } from "../services/demo-bridge-service";
import { streamKeyForSession } from "../state/reducer";
import { createStore } from "../state/store";

function setup(replyDelayMs?: number) {
  const store = createStore(createDemoState());
  const service = new DemoBridgeService(store, replyDelayMs);
  const sessionId = store.getState().plannerSessionId!;
  const busy = () => store.getState().sessions[sessionId]!.busy;
  const records = () => store.getState().streams[streamKeyForSession(sessionId)]?.records.length ?? 0;
  return { service, sessionId, busy, records };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DemoBridgeService.sendMessage", () => {
  it("session bận suốt thời gian chờ trả lời mặc định, hết giờ thì có câu trả lời và hết bận", async () => {
    const { service, sessionId, busy, records } = setup();
    const before = records();
    await service.sendMessage(sessionId, "xin chào");
    expect(busy()).toBe(true);
    expect(records()).toBe(before + 1);

    vi.advanceTimersByTime(DEMO_REPLY_DELAY_MS - 1);
    expect(busy()).toBe(true);
    expect(records()).toBe(before + 1);

    vi.advanceTimersByTime(1);
    expect(busy()).toBe(false);
    expect(records()).toBe(before + 2);
  });

  it("thời gian chờ truyền vào được (test không phải đợi mặc định)", async () => {
    const { service, sessionId, busy } = setup(10);
    await service.sendMessage(sessionId, "nhanh");
    vi.advanceTimersByTime(10);
    expect(busy()).toBe(false);
  });

  it("mặc định dài hơn quãng đi home → work của cả hai agent, còn dư ít nhất 1 s đứng làm việc", () => {
    const WORKING_VISIBLE_MS = 1_000;
    for (const agent of [OFFICE_LAYOUT.planner, OFFICE_LAYOUT.orchestrator]) {
      let at = agent.home.anchor;
      let walkMs = AGENT_SPOT_DELAY_MS.work;
      for (const p of planRoute(agent.home, agent.work)) {
        walkMs += segmentMs(at, p);
        at = p;
      }
      expect(DEMO_REPLY_DELAY_MS).toBeGreaterThanOrEqual(walkMs + WORKING_VISIBLE_MS);
    }
  });
});
