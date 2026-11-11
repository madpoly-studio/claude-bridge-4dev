// Hạn mức seat (mục 10.3, 10.4): nguồn duy nhất là `rate_limit_event` của SDK và lỗi rate limit của turn.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SeatUsage, SystemStatus } from "@claude-bridge/protocol";
import { type Clock, toIso } from "../util/clock.js";

/** resetsAt của SDK là epoch giây; giá trị lớn hơn ngưỡng này được coi là mili giây. */
const EPOCH_MS_THRESHOLD = 1e12;

export class SeatTracker {
  private usage: SeatUsage | undefined;
  private limitedUntil: string | null | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly onChanged: () => void,
  ) {}

  status(): Pick<SystemStatus, "seat_usage" | "rate_limited_until"> {
    const until = this.limitedUntil;
    // Hết thời điểm reset thì coi như không còn bị chặn.
    const expired = typeof until === "string" && Date.parse(until) <= this.clock.now();
    return {
      ...(this.usage !== undefined ? { seat_usage: this.usage } : {}),
      ...(until !== undefined && !expired ? { rate_limited_until: until } : {}),
    };
  }

  observe(message: SDKMessage): void {
    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info;
      const resetsAt = info.resetsAt === undefined ? null : toIso(toEpochMs(info.resetsAt));
      this.usage = { status: info.status, resets_at: resetsAt, utilization: info.utilization ?? windowUtilization(info) };
      this.limitedUntil = info.status === "rejected" ? resetsAt : undefined;
      this.onChanged();
      return;
    }
    if (message.type === "assistant" && message.error === "rate_limit") {
      // Không có thời điểm reset trong lỗi: dùng thời điểm từ rate_limit_event gần nhất nếu có.
      this.limitedUntil = this.usage?.resets_at ?? null;
      this.usage = { status: "rejected", resets_at: this.usage?.resets_at ?? null, utilization: this.usage?.utilization ?? null };
      this.onChanged();
    }
  }
}

/**
 * CLI 2.1.322 gửi utilization trong `unifiedWindows[rateLimitType]` (không có trong kiểu công khai của SDK),
 * còn field `utilization` ở cấp ngoài thì vắng.
 */
function windowUtilization(info: { rateLimitType?: string }): number | null {
  const windows = (info as { unifiedWindows?: Record<string, { utilization?: unknown }> }).unifiedWindows;
  const value = info.rateLimitType ? windows?.[info.rateLimitType]?.utilization : undefined;
  return typeof value === "number" ? value : null;
}

function toEpochMs(value: number): number {
  return value < EPOCH_MS_THRESHOLD ? value * 1000 : value;
}
