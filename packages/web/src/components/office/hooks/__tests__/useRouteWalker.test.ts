import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { OFFICE_LAYOUT } from "../../model/layout";
import { planRoute } from "../../model/route";
import { useRouteWalker } from "../useRouteWalker";

interface Place {
  x: number;
  y: number;
  gateX: number;
  gateY: number;
  facing: 1 | -1;
  reducedMotion: boolean;
}

// Các chỗ đứng cách xa nhau, mỗi chỗ có gate riêng: tuyến đi có nhiều đoạn (gate cũ → gate mới → đích).
const HOME: Place = { x: 100, y: 100, gateX: 100, gateY: 200, facing: 1, reducedMotion: false };
const AWAY: Place = { x: 600, y: 500, gateX: 600, gateY: 400, facing: -1, reducedMotion: false };
const THIRD: Place = { x: 900, y: 100, gateX: 900, gateY: 200, facing: 1, reducedMotion: false };
/** Dư sức cho mọi đoạn kể cả thời gian chờ dự phòng. */
const LONG_MS = 60_000;
const FRAME_MS = 50;

const walker = (initial: Place) =>
  renderHook((p: Place) => useRouteWalker(p.x, p.y, p.gateX, p.gateY, p.facing, p.reducedMotion), { initialProps: initial });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date", "performance"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useRouteWalker", () => {
  it("lần vẽ đầu đứng ngay tại chỗ, không đi; transition chỉ bật sau khung hình đầu", () => {
    const { result } = walker(HOME);
    expect(result.current).toMatchObject({ x: 100, y: 100, moving: false, facing: 1, segmentMs: 0, ready: false });
    act(() => void vi.advanceTimersByTime(FRAME_MS));
    expect(result.current).toMatchObject({ x: 100, y: 100, moving: false, ready: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("đổi đích: đi lần lượt qua các waypoint theo transitionend rồi dừng đúng đích, hết trạng thái moving", () => {
    const route = planRoute(
      { anchor: { x: HOME.x, y: HOME.y }, gate: { x: HOME.gateX, y: HOME.gateY } },
      { anchor: { x: AWAY.x, y: AWAY.y }, gate: { x: AWAY.gateX, y: AWAY.gateY } },
    );
    expect(route.length).toBeGreaterThan(1);
    const { result, rerender } = walker(HOME);
    act(() => void vi.advanceTimersByTime(FRAME_MS));
    rerender(AWAY);

    const visited: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < route.length; i++) {
      expect(result.current.moving).toBe(true);
      expect(result.current.segmentMs).toBeGreaterThan(0);
      visited.push({ x: result.current.x, y: result.current.y });
      act(() => result.current.onSegmentEnd());
    }
    expect(visited).toEqual(route);
    expect(result.current).toMatchObject({ x: AWAY.x, y: AWAY.y, moving: false, facing: AWAY.facing, segmentMs: 0 });
    // Không còn timer dự phòng nào treo sau khi tới nơi.
    expect(vi.getTimerCount()).toBe(0);
    // transitionend đến muộn không làm robot đi tiếp.
    act(() => result.current.onSegmentEnd());
    expect(result.current).toMatchObject({ x: AWAY.x, y: AWAY.y, moving: false });
  });

  it("transitionend không bao giờ tới (tab ẩn): timer dự phòng vẫn đưa robot tới đích, không kẹt ở moving", () => {
    const { result, rerender } = walker(HOME);
    act(() => void vi.advanceTimersByTime(FRAME_MS));
    rerender(AWAY);
    expect(result.current.moving).toBe(true);
    act(() => void vi.advanceTimersByTime(LONG_MS));
    expect(result.current).toMatchObject({ x: AWAY.x, y: AWAY.y, moving: false, facing: AWAY.facing });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("đổi đích giữa đường: bỏ tuyến cũ, tới đích mới", () => {
    const { result, rerender } = walker(HOME);
    act(() => void vi.advanceTimersByTime(FRAME_MS));
    rerender(AWAY);
    act(() => result.current.onSegmentEnd());
    expect(result.current.moving).toBe(true);
    rerender(THIRD);
    expect(result.current.moving).toBe(true);
    act(() => void vi.advanceTimersByTime(LONG_MS));
    expect(result.current).toMatchObject({ x: THIRD.x, y: THIRD.y, moving: false, facing: THIRD.facing });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("đổi đích khi đang đi giữa hai gate: đã ở trên lối đi, sang thẳng gate mới", () => {
    const { result, rerender } = walker(HOME);
    act(() => void vi.advanceTimersByTime(FRAME_MS));
    rerender(AWAY);
    // Tới gate của HOME, đang hướng sang gate của AWAY.
    act(() => result.current.onSegmentEnd());
    expect(result.current).toMatchObject({ x: AWAY.gateX, y: AWAY.gateY, moving: true });
    rerender(THIRD);
    expect(result.current).toMatchObject({ x: THIRD.gateX, y: THIRD.gateY, moving: true });
    act(() => result.current.onSegmentEnd());
    expect(result.current).toMatchObject({ x: THIRD.x, y: THIRD.y, moving: true });
  });

  it("đổi đích khi đang ở đoạn cuối từ gate vào chỗ cũ: lùi ra qua gate của chỗ cũ rồi mới sang gate mới", () => {
    const { result, rerender } = walker(HOME);
    act(() => void vi.advanceTimersByTime(FRAME_MS));
    rerender(AWAY);
    act(() => result.current.onSegmentEnd());
    act(() => result.current.onSegmentEnd());
    // Đoạn cuối: từ gate của AWAY vào chỗ AWAY.
    expect(result.current).toMatchObject({ x: AWAY.x, y: AWAY.y, moving: true });
    const approachMs = result.current.segmentMs;
    act(() => void vi.advanceTimersByTime(approachMs / 2));

    rerender(THIRD);
    const visited: Array<{ x: number; y: number }> = [];
    // Đoạn lùi ra tính từ vị trí thật (mới đi nửa đoạn), nên ngắn hơn cả đoạn vào.
    expect(result.current.segmentMs).toBeLessThan(approachMs);
    while (result.current.moving) {
      visited.push({ x: result.current.x, y: result.current.y });
      act(() => result.current.onSegmentEnd());
    }
    expect(visited).toEqual([
      { x: AWAY.gateX, y: AWAY.gateY },
      { x: THIRD.gateX, y: THIRD.gateY },
      { x: THIRD.x, y: THIRD.y },
    ]);
    expect(result.current).toMatchObject({ x: THIRD.x, y: THIRD.y, moving: false, facing: THIRD.facing });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("planner đang vào góc home thì có việc: quay ra qua gate của home, không đi thẳng qua bàn tới gate của chỗ làm", () => {
    const { home, work } = OFFICE_LAYOUT.planner;
    const place = (s: typeof home): Place => ({ x: s.anchor.x, y: s.anchor.y, gateX: s.gate.x, gateY: s.gate.y, facing: s.facing, reducedMotion: false });
    const { result, rerender } = walker(place(work));
    act(() => void vi.advanceTimersByTime(FRAME_MS));
    rerender(place(home));
    act(() => result.current.onSegmentEnd());
    act(() => result.current.onSegmentEnd());
    expect(result.current).toMatchObject({ ...home.anchor, moving: true });
    act(() => void vi.advanceTimersByTime(result.current.segmentMs / 2));

    rerender(place(work));
    const visited: Array<{ x: number; y: number }> = [];
    while (result.current.moving) {
      visited.push({ x: result.current.x, y: result.current.y });
      act(() => result.current.onSegmentEnd());
    }
    expect(visited).toEqual([home.gate, work.gate, work.anchor]);
  });

  it("quay đầu giữa đoạn: thời lượng đoạn đầu tính từ vị trí thật, không phải từ waypoint đang hướng tới", () => {
    // Gate trùng chỗ đứng: tuyến chỉ có một đoạn thẳng dài 1000 px.
    const a: Place = { x: 0, y: 100, gateX: 0, gateY: 100, facing: 1, reducedMotion: false };
    const b: Place = { x: 1000, y: 100, gateX: 1000, gateY: 100, facing: 1, reducedMotion: false };
    const { result, rerender } = walker(a);
    act(() => void vi.advanceTimersByTime(FRAME_MS));
    rerender(b);
    const full = result.current.segmentMs;
    expect(result.current).toMatchObject({ x: 1000, moving: true, facing: 1 });
    // Đi được một phần tư đường thì quay về.
    act(() => void vi.advanceTimersByTime(full / 4));
    rerender(a);
    expect(result.current).toMatchObject({ x: 0, y: 100, moving: true, facing: -1 });
    expect(result.current.segmentMs).toBeGreaterThan(full / 4 - FRAME_MS);
    expect(result.current.segmentMs).toBeLessThan(full / 4 + FRAME_MS);
    act(() => result.current.onSegmentEnd());
    expect(result.current).toMatchObject({ x: 0, y: 100, moving: false, facing: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reduced motion: nhảy thẳng tới đích, không qua trạng thái moving, không đặt timer", () => {
    const { result, rerender } = walker({ ...HOME, reducedMotion: true });
    act(() => void vi.advanceTimersByTime(FRAME_MS));
    rerender({ ...AWAY, reducedMotion: true });
    expect(result.current).toMatchObject({ x: AWAY.x, y: AWAY.y, moving: false, facing: AWAY.facing, segmentMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gỡ component giữa đường: dọn timer dự phòng và khung hình đang chờ", () => {
    const { result, rerender, unmount } = walker(HOME);
    rerender(AWAY);
    expect(result.current.moving).toBe(true);
    // Một timer dự phòng của đoạn đang đi + khung hình bật `ready` còn chờ.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
