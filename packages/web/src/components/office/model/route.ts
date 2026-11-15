// Tuyến đi của robot: chỗ đang đứng → gate của nó → gate của đích → đích. Thuần.
import { MIN_SEGMENT_MS, ROUTE_MIN_GAP_PX, WALK_SPEED_PX_S } from "../constants";
import { distance } from "./geometry";
import type { Facing, Point } from "./geometry";

export interface Placement {
  anchor: Point;
  gate: Point;
}

/**
 * Các waypoint còn phải đi, kết thúc ở to.anchor. Bỏ điểm trung gian cách điểm trước dưới ROUTE_MIN_GAP_PX.
 * `from` là chỗ robot đang đứng (hoặc waypoint nó đang hướng tới).
 */
export function planRoute(from: Placement, to: Placement): Point[] {
  const out: Point[] = [];
  let prev = from.anchor;
  for (const p of [from.gate, to.gate]) {
    if (distance(prev, p) < ROUTE_MIN_GAP_PX) continue;
    out.push(p);
    prev = p;
  }
  // Điểm trung gian sát đích thì bỏ, đi thẳng tới đích.
  if (out.length > 0 && distance(prev, to.anchor) < ROUTE_MIN_GAP_PX) out.pop();
  out.push(to.anchor);
  return out;
}

export function segmentMs(from: Point, to: Point): number {
  return Math.max(MIN_SEGMENT_MS, Math.round((distance(from, to) / WALK_SPEED_PX_S) * 1000));
}

const NEARLY_VERTICAL_PX = 6;

/** Đi sang trái thì -1, sang phải 1, gần như thẳng đứng thì giữ fallback. */
export function facingOf(from: Point, to: Point, fallback: Facing): Facing {
  const dx = to.x - from.x;
  if (Math.abs(dx) < NEARLY_VERTICAL_PX) return fallback;
  return dx < 0 ? -1 : 1;
}
