import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import styles from "./topbar.module.css";

export type ChipTone = "ok" | "warn" | "danger" | "off" | "none";

interface StatusChipProps {
  label: string;
  value: ReactNode;
  tone?: ChipTone;
  /** Mô tả đầy đủ cho trình đọc màn hình / tooltip. */
  title?: string;
}

const DOT: Record<ChipTone, string | undefined> = {
  ok: styles.dotOk,
  warn: styles.dotWarn,
  danger: styles.dotDanger,
  off: styles.dotOff,
  none: undefined,
};

/** Chip trạng thái: chấm màu chỉ là phụ, giá trị luôn hiện bằng chữ. */
export function StatusChip({ label, value, tone = "none", title }: StatusChipProps) {
  return (
    <li className={cx(styles.chip, tone === "warn" && styles.chipWarn, tone === "danger" && styles.chipDanger)} title={title}>
      {tone !== "none" && <span className={cx(styles.dot, DOT[tone])} aria-hidden="true" />}
      <span className={styles.chipLabel}>{label}</span>
      <span>{value}</span>
    </li>
  );
}
