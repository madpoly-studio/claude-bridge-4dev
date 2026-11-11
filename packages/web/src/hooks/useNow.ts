import { useEffect, useState } from "react";
import { CLOCK_TICK_MS } from "../config";

/** Thời điểm hiện tại, cập nhật theo chu kỳ để hiển thị thời lượng. */
export function useNow(intervalMs: number = CLOCK_TICK_MS, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}
