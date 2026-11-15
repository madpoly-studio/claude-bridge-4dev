import { useEffect, useState } from "react";
import { AGENT_SPOT_DELAY_MS } from "../constants";
import type { AgentSpot } from "../model/geometry";

/**
 * Chỗ agent thật sự đi tới: chỉ theo `spot` sau khi giá trị mới giữ nguyên đủ AGENT_SPOT_DELAY_MS của nó.
 * `spot` đổi lại trước hạn thì bỏ, nên robot không quay đầu vì một lượt bận / rảnh chớp nhoáng.
 * Lần mount đầu lấy ngay `spot` hiện tại.
 */
export function useSettledSpot(spot: AgentSpot): AgentSpot {
  const [settled, setSettled] = useState(spot);
  useEffect(() => {
    if (spot === settled) return;
    const id = setTimeout(() => setSettled(spot), AGENT_SPOT_DELAY_MS[spot]);
    return () => clearTimeout(id);
  }, [spot, settled]);
  return settled;
}
