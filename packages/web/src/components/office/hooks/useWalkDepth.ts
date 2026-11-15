import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { WalkState } from "./useRouteWalker";

/**
 * Giữ z-index của robot (và thẻ tên của nó) bám theo y trên cảnh, kể cả trong lúc trượt.
 * z-index không nằm trong style của React: hook ghi thẳng lên DOM.
 * `labelLayer` chỉ để chạy lại khi thẻ tên (portal) mount sau robot.
 */
export function useWalkDepth(
  walk: Pick<WalkState, "moving" | "x" | "y" | "segmentMs">,
  actorRef: RefObject<HTMLElement>,
  tagRef: RefObject<HTMLElement>,
  labelLayer: HTMLElement | null,
): void {
  // y hiện tại của robot trên cảnh (ước lượng); đứng yên thì bằng walk.y.
  const liveY = useRef(walk.y);

  // Trong lúc trượt, chiều sâu phải bám theo vị trí trên màn hình (Chrome không nội suy z-index trong transition).
  // Mỗi đoạn là một transition tuyến tính dài segmentMs, nên y từng khung hình tự nội suy được từ dữ liệu của walker,
  // không phải đọc getComputedStyle (ép tính lại style mỗi khung hình cho từng robot). Đổi đích giữa đường:
  // effect chạy lại và nối tiếp từ y đang ước lượng, giống cách CSS nối transition từ vị trí hiện tại.
  useEffect(() => {
    const el = actorRef.current;
    if (!walk.moving || !el || typeof requestAnimationFrame === "undefined") return;
    const fromY = liveY.current;
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = walk.segmentMs > 0 ? Math.min(1, Math.max(0, (now - startedAt) / walk.segmentMs)) : 1;
      const y = fromY + (walk.y - fromY) * t;
      liveY.current = y;
      const z = String(Math.round(y));
      if (el.style.zIndex !== z) el.style.zIndex = z;
      const tagEl = tagRef.current;
      if (tagEl && tagEl.style.zIndex !== z) tagEl.style.zIndex = z;
      // Hết đoạn thì dừng; đoạn kế tiếp (walk.x / walk.y đổi) khởi động lại effect.
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [walk.moving, walk.x, walk.y, walk.segmentMs, actorRef, tagRef]);

  // Đứng yên: chiều sâu theo chỗ đứng. Layout effect để có trước lần vẽ đầu.
  useLayoutEffect(() => {
    if (walk.moving) return;
    liveY.current = walk.y;
    const z = String(Math.round(walk.y));
    if (actorRef.current) actorRef.current.style.zIndex = z;
    if (tagRef.current) tagRef.current.style.zIndex = z;
  }, [walk.moving, walk.y, labelLayer, actorRef, tagRef]);
}
