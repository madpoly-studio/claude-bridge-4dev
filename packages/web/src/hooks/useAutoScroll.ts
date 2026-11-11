import { useLayoutEffect, useRef } from "react";

const NEAR_BOTTOM_PX = 80;

/** Giữ khung cuộn ở cuối khi có nội dung mới, trừ khi người dùng đã cuộn lên xem lại. */
export function useAutoScroll<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);

  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  return { ref, onScroll };
}
