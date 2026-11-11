import { TASK_PHASES } from "@claude-bridge/protocol";
import type { TaskPhase } from "@claude-bridge/protocol";
import { cx } from "../../lib/cx";
import styles from "./phase-bar.module.css";

interface PhaseBarProps {
  phase: TaskPhase | null;
  /** compact: một dải 5 đoạn + nhãn phase hiện tại; labeled: nhãn dưới từng đoạn. */
  variant?: "compact" | "labeled";
  /** Task lỗi: đoạn đã qua tô màu cảnh báo. */
  failed?: boolean;
}

const NO_PHASE_LABEL = "chưa báo phase";

/** Thanh 5 phase theo TASK_PHASES; luôn kèm nhãn chữ, không chỉ dựa vào màu. */
export function PhaseBar({ phase, variant = "compact", failed = false }: PhaseBarProps) {
  const index = phase ? TASK_PHASES.indexOf(phase) : -1;
  const label = phase ?? NO_PHASE_LABEL;
  const ariaText = phase ? `Phase ${index + 1}/${TASK_PHASES.length}: ${phase}${failed ? " (lỗi)" : ""}` : NO_PHASE_LABEL;

  if (variant === "labeled") {
    return (
      <ol className={styles.labeled} aria-label={ariaText}>
        {TASK_PHASES.map((p, i) => (
          <li key={p} className={styles.labeledItem} aria-current={i === index ? "step" : undefined}>
            <span className={cx(styles.segment, i <= index && (failed ? styles.failed : styles.done))} />
            <span className={cx(styles.phaseName, i <= index && styles.phaseNameDone, i === index && styles.phaseNameCurrent)}>{p}</span>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <div className={styles.compact}>
      <span className={styles.segments} role="img" aria-label={ariaText}>
        {TASK_PHASES.map((p, i) => (
          <span key={p} className={cx(styles.segment, i <= index && (failed ? styles.failed : styles.done))} />
        ))}
      </span>
      <span className={styles.current} aria-hidden="true">
        {label}
      </span>
    </div>
  );
}
