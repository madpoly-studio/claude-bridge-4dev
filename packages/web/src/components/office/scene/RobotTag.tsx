import { TASK_PHASES } from "@claude-bridge/protocol";
import type { CSSProperties } from "react";
import { cx } from "../../../lib/cx";
import styles from "./scene.module.css";

export type TagTone = "busy" | "idle" | "offline" | "wait" | "done" | "fail" | "alert";

interface RobotTagProps {
  name: string;
  stateLabel: string;
  tone: TagTone;
  detail?: string | null;
  /** -1: có task nhưng chưa báo phase; 0..4; null: không hiện dải phase. */
  phaseIndex?: number | null;
  /** Vị trí so với điểm neo của robot (hệ cảnh). */
  offsetX: number;
  offsetY: number;
  /** Xếp tên và trạng thái thành hai dòng (thẻ hẹp hơn, dùng cho agent có nhãn dài). */
  stacked?: boolean;
}

/**
 * Thẻ tên dưới robot: tên, nhãn trạng thái bằng chữ, dòng phụ và 5 chấm phase.
 * aria-hidden vì toàn bộ nội dung đã có trong aria-label của nút robot.
 */
export function RobotTag({ name, stateLabel, tone, detail = null, phaseIndex = null, offsetX, offsetY, stacked = false }: RobotTagProps) {
  const style = { "--tag-x": `${offsetX}px`, "--tag-y": `${offsetY}px` } as CSSProperties;
  return (
    <div className={styles.tag} data-tone={tone} style={style} aria-hidden="true">
      <span className={cx(styles.tagRow, stacked && styles.tagRowStacked)}>
        <span className={styles.tagName}>{name}</span>
        <span className={styles.tagState}>{stateLabel}</span>
      </span>
      {(detail || phaseIndex !== null) && (
        <span className={styles.tagRow}>
          {detail && <span className={styles.tagDetail}>{detail}</span>}
          {phaseIndex !== null && (
            <span className={styles.dots}>
              {TASK_PHASES.map((p, i) => (
                <span key={p} className={cx(styles.dot, i <= phaseIndex && styles.dotOn)} />
              ))}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
