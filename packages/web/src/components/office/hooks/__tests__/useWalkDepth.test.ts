import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useWalkDepth } from "../useWalkDepth";

interface Walk {
  moving: boolean;
  x: number;
  y: number;
  segmentMs: number;
}

const START_Y = 100;
const END_Y = 500;
const SEGMENT_MS = 1_000;
/** Một khung hình của đồng hồ giả (16 ms) ứng với bấy nhiêu px trên đoạn START_Y → END_Y. */
const FRAME_TOLERANCE_PX = 8;

const STANDING: Walk = { moving: false, x: 0, y: START_Y, segmentMs: 0 };
const WALKING: Walk = { moving: true, x: 0, y: END_Y, segmentMs: SEGMENT_MS };

function setup(initial: Walk) {
  const actor = document.createElement("div");
  const tag = document.createElement("div");
  const actorRef = { current: actor };
  const tagRef = { current: tag };
  const hook = renderHook((walk: Walk) => useWalkDepth(walk, actorRef, tagRef, null), { initialProps: initial });
  return { actor, tag, ...hook };
}

const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const depth = (el: HTMLElement) => Number(el.style.zIndex);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "Date", "performance"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useWalkDepth", () => {
  it("đứng yên: z-index của robot và thẻ tên bằng y của chỗ đứng, không chạy khung hình nào", () => {
    const { actor, tag } = setup({ ...STANDING, y: 123.4 });
    expect(actor.style.zIndex).toBe("123");
    expect(tag.style.zIndex).toBe("123");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("đang đi: z-index tăng dần theo từng khung hình, bám y nội suy tuyến tính của đoạn", () => {
    const { actor, tag, rerender } = setup(STANDING);
    rerender(WALKING);
    // Chưa có khung hình nào: vẫn là chiều sâu của chỗ vừa rời.
    expect(depth(actor)).toBe(START_Y);

    const seen: number[] = [];
    for (const quarter of [1, 2, 3]) {
      wait(SEGMENT_MS / 4);
      const expected = START_Y + ((END_Y - START_Y) * quarter) / 4;
      expect(depth(actor)).toBeGreaterThan(expected - FRAME_TOLERANCE_PX);
      expect(depth(actor)).toBeLessThanOrEqual(expected);
      expect(tag.style.zIndex).toBe(actor.style.zIndex);
      seen.push(depth(actor));
    }
    expect(seen[0]!).toBeLessThan(seen[1]!);
    expect(seen[1]!).toBeLessThan(seen[2]!);
  });

  it("hết đoạn: z-index dừng đúng y của waypoint và vòng khung hình tự dừng", () => {
    const { actor, tag, rerender } = setup(STANDING);
    rerender(WALKING);
    wait(SEGMENT_MS * 2);
    expect(depth(actor)).toBe(END_Y);
    expect(depth(tag)).toBe(END_Y);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("đổi đích giữa đoạn: nối tiếp từ y đang ước lượng, không nhảy về đầu hay cuối đoạn cũ", () => {
    const { actor, rerender } = setup(STANDING);
    rerender(WALKING);
    wait(SEGMENT_MS / 2);
    const midY = START_Y + (END_Y - START_Y) / 2;
    expect(depth(actor)).toBeGreaterThan(midY - FRAME_TOLERANCE_PX);
    expect(depth(actor)).toBeLessThanOrEqual(midY);

    // Quay đầu về chỗ cũ, đoạn mới dài 400 ms.
    const backMs = 400;
    rerender({ moving: true, x: 0, y: START_Y, segmentMs: backMs });
    wait(backMs / 2);
    const expected = midY + (START_Y - midY) / 2;
    // Nếu nội suy lại từ END_Y thì lúc này z ≈ 300; nếu từ START_Y thì z = 100.
    expect(depth(actor)).toBeGreaterThanOrEqual(expected - FRAME_TOLERANCE_PX);
    expect(depth(actor)).toBeLessThan(expected + 2 * FRAME_TOLERANCE_PX);
    wait(backMs);
    expect(depth(actor)).toBe(START_Y);
  });

  it("tới nơi (moving = false): z-index của robot và thẻ tên bằng đúng y của đích", () => {
    const { actor, tag, rerender } = setup(STANDING);
    rerender(WALKING);
    wait(SEGMENT_MS / 4);
    // Walker báo tới nơi trước khi vòng khung hình kịp chạy hết đoạn (transitionend đến sớm hơn đồng hồ ước lượng).
    rerender({ moving: false, x: 0, y: END_Y, segmentMs: 0 });
    expect(actor.style.zIndex).toBe(String(END_Y));
    expect(tag.style.zIndex).toBe(String(END_Y));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gỡ component giữa đường: hủy khung hình đang chờ, z-index không còn bị ghi", () => {
    const { actor, rerender, unmount } = setup(STANDING);
    rerender(WALKING);
    wait(SEGMENT_MS / 4);
    expect(vi.getTimerCount()).toBe(1);
    const before = actor.style.zIndex;
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    wait(SEGMENT_MS);
    expect(actor.style.zIndex).toBe(before);
  });
});
