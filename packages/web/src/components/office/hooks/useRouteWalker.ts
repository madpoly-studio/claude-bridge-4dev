import { useCallback, useEffect, useRef, useState } from "react";
import { WALK_FALLBACK_SLACK_MS } from "../constants";
import type { Facing, Point } from "../model/geometry";
import { facingOf, planRoute, segmentMs } from "../model/route";

export interface WalkState {
  x: number;
  y: number;
  moving: boolean;
  facing: Facing;
  segmentMs: number;
  /** false ở lần vẽ đầu: đặt thẳng vào chỗ, không trượt. */
  ready: boolean;
}

export interface Walker extends WalkState {
  /** Gọi khi transition `transform` của phần tử robot kết thúc. */
  onSegmentEnd: () => void;
}

/**
 * Đưa robot tới đích qua các waypoint của planRoute, mỗi đoạn một CSS transition tuyến tính.
 * Đổi đích giữa đường: lập tuyến mới từ waypoint đang hướng tới, CSS tự nối từ vị trí hiện tại
 * (thời lượng đoạn đầu tính theo vị trí ước lượng đó). Đổi đích khi đang ở đoạn cuối vào chỗ cũ: lùi ra qua gate của chỗ cũ.
 */
export function useRouteWalker(targetX: number, targetY: number, gateX: number, gateY: number, restFacing: Facing, reducedMotion: boolean): Walker {
  const [state, setState] = useState<WalkState>({ x: targetX, y: targetY, moving: false, facing: restFacing, segmentMs: 0, ready: false });
  const heading = useRef<Point>({ x: targetX, y: targetY });
  /** Đoạn đang trượt, để ước lượng vị trí thật khi đổi đích giữa đường. */
  const segment = useRef<{ from: Point; startedAt: number; ms: number } | null>(null);
  const restGate = useRef<Point>({ x: gateX, y: gateY });
  const queue = useRef<Point[]>([]);
  const moving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTarget = useRef<Point>({ x: targetX, y: targetY });
  const restFacingRef = useRef(restFacing);
  restFacingRef.current = restFacing;

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  /** `origin`: vị trí thật của robot khi rẽ giữa đoạn; bỏ trống thì robot đang đứng đúng waypoint vừa tới. */
  const advance = useCallback((origin?: Point) => {
    clearTimer();
    const next = queue.current.shift();
    if (!next) {
      moving.current = false;
      segment.current = null;
      setState((s) => ({ ...s, moving: false, facing: restFacingRef.current, segmentMs: 0 }));
      return;
    }
    const from = origin ?? heading.current;
    const ms = segmentMs(from, next);
    heading.current = next;
    moving.current = true;
    segment.current = { from, startedAt: performance.now(), ms };
    setState((s) => ({ ...s, x: next.x, y: next.y, moving: true, facing: facingOf(from, next, s.facing), segmentMs: ms }));
    // Dự phòng khi transitionend không tới (tab ẩn, phần tử bị gỡ transition).
    timer.current = setTimeout(() => advance(), ms + WALK_FALLBACK_SLACK_MS);
  }, []);

  useEffect(() => {
    const target = { x: targetX, y: targetY };
    const gate = { x: gateX, y: gateY };
    // Đích không đổi (lần mount đầu, StrictMode chạy lại effect): không lập tuyến.
    if (lastTarget.current.x === target.x && lastTarget.current.y === target.y) {
      restGate.current = gate;
      return;
    }
    const prevTarget = lastTarget.current;
    lastTarget.current = target;
    if (reducedMotion) {
      clearTimer();
      queue.current = [];
      moving.current = false;
      segment.current = null;
      heading.current = target;
      restGate.current = gate;
      setState((s) => ({ ...s, x: target.x, y: target.y, moving: false, facing: restFacingRef.current, segmentMs: 0 }));
      return;
    }
    // Đang đi giữa các gate thì đã ở trên lối đi: không quay lại gate của chỗ cũ. Riêng đoạn cuối (từ gate vào chỗ cũ)
    // đã rời lối đi: phải lùi ra qua gate của chỗ cũ, nếu không đường thẳng tới gate mới sẽ cắt qua nội thất.
    // Tuyến mới vẫn lập từ waypoint đang hướng tới, nhưng thời lượng và hướng mặt của đoạn đầu tính từ vị trí thật,
    // để robot quay đầu không chậm hay nhanh bất thường.
    const onApproachLeg = moving.current && heading.current.x === prevTarget.x && heading.current.y === prevTarget.y;
    const from = { anchor: heading.current, gate: moving.current && !onApproachLeg ? heading.current : restGate.current };
    const seg = moving.current ? segment.current : null;
    let origin: Point | undefined;
    if (seg) {
      const t = seg.ms > 0 ? Math.min(1, Math.max(0, (performance.now() - seg.startedAt) / seg.ms)) : 1;
      origin = { x: seg.from.x + (heading.current.x - seg.from.x) * t, y: seg.from.y + (heading.current.y - seg.from.y) * t };
    }
    queue.current = planRoute(from, { anchor: target, gate });
    restGate.current = gate;
    advance(origin);
  }, [targetX, targetY, gateX, gateY, reducedMotion, advance]);

  // Chỉ đổi hướng nghỉ (ví dụ slot khác hướng) khi đang đứng yên.
  useEffect(() => {
    if (!moving.current) setState((s) => (s.facing === restFacing ? s : { ...s, facing: restFacing }));
  }, [restFacing]);

  // Bật transition sau khung hình đầu để lần vẽ đầu không trượt.
  useEffect(() => {
    const id = requestAnimationFrame(() => setState((s) => (s.ready ? s : { ...s, ready: true })));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => clearTimer, []);

  const onSegmentEnd = useCallback(() => {
    if (moving.current) advance();
  }, [advance]);

  return { ...state, onSegmentEnd };
}
