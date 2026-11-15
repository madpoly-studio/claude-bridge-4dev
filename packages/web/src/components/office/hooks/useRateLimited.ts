import { useEffect, useState } from "react";
import type { SystemStatus } from "@claude-bridge/protocol";

/** Cùng quy tắc với selectors.isRateLimited: thời điểm không đọc được thì coi như đang bị giới hạn. */
function limitedAt(until: string | null | undefined, now: number): boolean {
  if (!until) return false;
  const t = new Date(until).getTime();
  return Number.isNaN(t) ? true : t > now;
}

/** Đang bị rate limit hay không; một timeout tới rate_limited_until thay vì đồng hồ chạy liên tục. */
export function useRateLimited(status: SystemStatus | null): boolean {
  const until = status?.rate_limited_until ?? null;
  const [limited, setLimited] = useState(() => limitedAt(until, Date.now()));

  useEffect(() => {
    const now = Date.now();
    const active = limitedAt(until, now);
    setLimited(active);
    if (!active || !until) return;
    const t = new Date(until).getTime();
    if (Number.isNaN(t)) return;
    // setTimeout giới hạn ở 2^31 - 1 ms.
    const id = setTimeout(() => setLimited(false), Math.min(t - now + 50, 2_147_483_647));
    return () => clearTimeout(id);
  }, [until]);

  return limited;
}
