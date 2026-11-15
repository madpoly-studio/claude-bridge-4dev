import { memo } from "react";
import { COUNTDOWN_TICK_MS } from "../../../config";
import { useNow } from "../../../hooks/useNow";
import type { Point } from "../model/geometry";
import type { SceneSignals as Signals } from "../model/system";
import styles from "./scene.module.css";

interface SceneSignalsProps {
  signals: Signals;
  at: Point;
}

export const SIGNAL_TEXT = {
  paused: "TẠM DỪNG GIAO VIỆC",
  rateLimit: "RATE LIMIT",
  disconnected: "MẤT KẾT NỐI BACKEND",
} as const;

function countdown(until: string, now: number): string | null {
  const t = new Date(until).getTime();
  if (Number.isNaN(t)) return null;
  const sec = Math.max(0, Math.round((t - now) / 1000));
  const mm = Math.floor(sec / 60);
  return `còn ${String(mm).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

/** Biển treo giữa văn phòng cho các trạng thái hệ thống. Luôn có chữ; StatusBanners phía trên vẫn hiện đầy đủ. */
export const SceneSignals = memo(function SceneSignals({ signals, at }: SceneSignalsProps) {
  const limited = signals.rateLimitedUntil !== null;
  // Đồng hồ 1 giây chỉ chạy khi đang đếm ngược.
  const now = useNow(COUNTDOWN_TICK_MS, limited);
  if (!signals.paused && !limited && !signals.disconnected) return null;
  const remaining = signals.rateLimitedUntil ? countdown(signals.rateLimitedUntil, now) : null;
  return (
    <div className={styles.signals} style={{ left: at.x, top: at.y }} role="status">
      {signals.disconnected && (
        <span className={styles.sign} data-tone="danger">
          {SIGNAL_TEXT.disconnected}
        </span>
      )}
      {signals.paused && (
        <span className={styles.sign} data-tone="warn">
          {SIGNAL_TEXT.paused}
        </span>
      )}
      {limited && (
        <span className={styles.sign} data-tone="warn">
          {SIGNAL_TEXT.rateLimit}
          {remaining ? ` · ${remaining}` : ""}
          <span className={styles.signSub}>robot rảnh ra quầy cà phê</span>
        </span>
      )}
    </div>
  );
});
