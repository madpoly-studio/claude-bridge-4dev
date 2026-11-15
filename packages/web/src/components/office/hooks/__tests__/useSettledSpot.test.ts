import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { AGENT_SPOT_DELAY_MS } from "../../constants";
import type { AgentSpot } from "../../model/geometry";
import { useSettledSpot } from "../useSettledSpot";

const settle = (initial: AgentSpot) => renderHook((spot: AgentSpot) => useSettledSpot(spot), { initialProps: initial });
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSettledSpot", () => {
  it("lần mount đầu lấy ngay chỗ theo trạng thái hiện tại, không chờ", () => {
    expect(settle("work").result.current).toBe("work");
    expect(settle("home").result.current).toBe("home");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("có việc: rời góc sau một nhịp ngắn", () => {
    const { result, rerender } = settle("home");
    rerender("work");
    expect(result.current).toBe("home");
    wait(AGENT_SPOT_DELAY_MS.work - 1);
    expect(result.current).toBe("home");
    wait(1);
    expect(result.current).toBe("work");
  });

  it("hết việc: nán lại chỗ làm lâu hơn rồi mới về góc", () => {
    expect(AGENT_SPOT_DELAY_MS.home).toBeGreaterThan(AGENT_SPOT_DELAY_MS.work);
    const { result, rerender } = settle("work");
    rerender("home");
    wait(AGENT_SPOT_DELAY_MS.home - 1);
    expect(result.current).toBe("work");
    wait(1);
    expect(result.current).toBe("home");
  });

  it("bận chớp nhoáng (ngắn hơn ngưỡng): robot không rời góc, không còn timer treo", () => {
    const { result, rerender } = settle("home");
    rerender("work");
    wait(AGENT_SPOT_DELAY_MS.work - 50);
    rerender("home");
    wait(AGENT_SPOT_DELAY_MS.home * 2);
    expect(result.current).toBe("home");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("nghỉ ngắn giữa hai lượt xử lý: robot ở yên chỗ làm", () => {
    const { result, rerender } = settle("work");
    rerender("home");
    wait(AGENT_SPOT_DELAY_MS.home - 100);
    rerender("work");
    wait(AGENT_SPOT_DELAY_MS.home * 2);
    expect(result.current).toBe("work");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gỡ component lúc đang chờ: dọn timer", () => {
    const { rerender, unmount } = settle("home");
    rerender("work");
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
