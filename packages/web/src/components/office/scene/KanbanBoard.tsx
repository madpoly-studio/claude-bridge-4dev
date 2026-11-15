import { memo, useEffect, useRef, useState } from "react";
import type { Point } from "../model/geometry";
import type { KanbanCounts } from "../model/system";
import styles from "./scene.module.css";

interface KanbanPlaqueProps {
  counts: KanbanCounts;
  at: Point;
  onOpen(opener: HTMLElement): void;
}

const COLUMNS: Array<{ key: keyof KanbanCounts; label: string; tone: string }> = [
  { key: "waiting", label: "CHỜ GIAO", tone: "dim" },
  { key: "inProgress", label: "ĐANG LÀM", tone: "accent" },
  { key: "review", label: "REVIEW", tone: "ok" },
  { key: "failed", label: "LỖI", tone: "warn" },
];

const PULSE_MS = 900;

/** Biển số của bảng kanban: số ticket từng nhóm (cùng nguồn với tab Tickets), bấm để mở danh sách ticket. */
export const KanbanPlaque = memo(function KanbanPlaque({ counts, at, onOpen }: KanbanPlaqueProps) {
  const prevReview = useRef(counts.review);
  const [pulse, setPulse] = useState(0);

  // Nháy một nhịp khi số CHỜ REVIEW tăng (lúc giấy note chạm bảng).
  useEffect(() => {
    const grew = counts.review > prevReview.current;
    prevReview.current = counts.review;
    if (!grew) return;
    setPulse((n) => n + 1);
  }, [counts.review]);

  useEffect(() => {
    if (pulse === 0) return;
    const id = setTimeout(() => setPulse(0), PULSE_MS);
    return () => clearTimeout(id);
  }, [pulse]);

  const summary = COLUMNS.map((c) => `${c.label.toLowerCase()} ${counts[c.key]}`).join(", ");
  return (
    <button
      type="button"
      className={styles.plaque}
      style={{ left: at.x, top: at.y }}
      aria-label={`Bảng ticket: ${summary}. Mở danh sách ticket`}
      onClick={(e) => onOpen(e.currentTarget)}
    >
      {COLUMNS.map((c) => (
        <span key={c.key} className={styles.plaqueCol} data-tone={c.tone} data-pulse={c.key === "review" && pulse > 0}>
          <span className={styles.plaqueNum}>{counts[c.key]}</span>
          <span className={styles.plaqueLabel}>{c.label}</span>
        </span>
      ))}
    </button>
  );
});
