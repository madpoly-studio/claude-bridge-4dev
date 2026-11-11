import type { SystemStatus } from "@claude-bridge/protocol";
import { cx } from "../../lib/cx";
import { formatHourMinute } from "../../lib/format";
import { StatusChip } from "./StatusChip";
import styles from "./topbar.module.css";

interface SeatChipProps {
  status: SystemStatus;
  now: number;
}

const PERCENT = 100;
const WARN_RATIO = 0.85;

/** Tỷ lệ dùng 0..1 (chấp nhận cả thang 0..100). */
function ratio(utilization: number | null | undefined): number | null {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  const r = utilization > 1 ? utilization / PERCENT : utilization;
  return Math.min(1, Math.max(0, r));
}

/** Chip "Hạn mức seat" (mục 10.4): chỉ hiện khi backend có dữ liệu seat hoặc đang bị rate limit. */
export function SeatChip({ status, now }: SeatChipProps) {
  const until = status.rate_limited_until ? new Date(status.rate_limited_until).getTime() : null;
  const limited = until !== null && (Number.isNaN(until) || until > now);

  if (limited) {
    return (
      <StatusChip
        label="Hạn mức seat"
        tone="danger"
        value={status.rate_limited_until && !Number.isNaN(until) ? `chạm hạn mức · đến ${formatHourMinute(status.rate_limited_until)}` : "chạm hạn mức"}
      />
    );
  }

  const usage = status.seat_usage;
  if (!usage) return null;
  const r = ratio(usage.utilization);
  const resets = usage.resets_at ? ` · reset ${formatHourMinute(usage.resets_at)}` : "";

  if (r === null) {
    return <StatusChip label="Hạn mức seat" value={`${usage.status}${resets}`} tone={usage.status === "allowed" ? "none" : "warn"} />;
  }
  const pct = Math.round(r * PERCENT);
  return (
    <StatusChip
      label="Hạn mức seat"
      tone={r >= WARN_RATIO ? "warn" : "none"}
      title={`Đã dùng ${pct}% hạn mức seat${resets}`}
      value={
        <span className={styles.meterWrap}>
          <span className={styles.meter} aria-hidden="true">
            <span className={cx(styles.meterFill, r >= WARN_RATIO && styles.meterFillWarn)} style={{ width: `${pct}%` }} />
          </span>
          <span>{pct}%</span>
        </span>
      }
    />
  );
}
