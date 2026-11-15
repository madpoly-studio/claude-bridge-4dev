import { memo } from "react";
import type { Point, ZoneId } from "../model/geometry";
import styles from "./scene.module.css";

interface OverflowChipProps {
  zone: ZoneId;
  count: number;
  at: Point;
  onOpen(opener: HTMLElement): void;
}

const ZONE_TEXT: Record<ZoneId, string> = {
  desk: "đang làm, chưa có bàn",
  relax: "đang nghỉ",
  pod: "offline",
};

/** Worker nhiều hơn số chỗ đã định: chip "+N" mở danh sách đầy đủ. */
export const OverflowChip = memo(function OverflowChip({ zone, count, at, onOpen }: OverflowChipProps) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      className={styles.chip}
      style={{ left: at.x, top: at.y }}
      aria-label={`Còn ${count} worker ${ZONE_TEXT[zone]}. Mở danh sách worker`}
      onClick={(e) => onOpen(e.currentTarget)}
    >
      <span className={styles.chipNum}>+{count}</span>
      <span>{ZONE_TEXT[zone]}</span>
    </button>
  );
});
