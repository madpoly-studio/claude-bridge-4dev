import { memo } from "react";
import { cx } from "../../lib/cx";
import { mrLabel } from "../../lib/format";
import type { TicketRow } from "../../state/selectors";
import ui from "../common/ui.module.css";
import styles from "./log.module.css";

export type TicketGroupKind = "waiting" | "inProgress" | "review" | "failed";

interface TicketRowViewProps {
  row: TicketRow;
  group: TicketGroupKind;
  onOpenTask: (taskId: string) => void;
}

const HIDDEN_LABELS = new Set(["agent"]);

export const TicketRowView = memo(function TicketRowView({ row, group, onOpenTask }: TicketRowViewProps) {
  const failed = group === "failed";
  const extraLabels = row.labels.filter((l) => !HIDDEN_LABELS.has(l));
  const key = row.url ? (
    <a href={row.url} target="_blank" rel="noreferrer" className={cx(styles.ticketKey, failed && styles.ticketKeyWarn)}>
      {row.key}
    </a>
  ) : (
    <span className={cx(styles.ticketKey, failed && styles.ticketKeyWarn)}>{row.key}</span>
  );

  return (
    <li className={cx(styles.ticketRow, failed && styles.ticketRowFailed)}>
      {key}
      <span className={styles.ticketSummary}>{row.summary || <span className={ui.dim}>(chưa có tiêu đề)</span>}</span>

      {group === "waiting" && (
        <>
          {extraLabels.map((l) => (
            <span key={l} className={ui.tag}>
              {l}
            </span>
          ))}
          {row.blockedBy.length > 0 && <span className={cx(ui.tag, ui.tagWarn)}>bị chặn bởi {row.blockedBy.join(", ")}</span>}
        </>
      )}

      {group === "inProgress" && row.task && (
        <button type="button" className={styles.linkButton} onClick={() => onOpenTask(row.task!.task_id)}>
          {row.task.worker_id}
          {row.task.state === "assigned" ? " · chờ khởi động" : ""}
        </button>
      )}

      {group === "review" &&
        (row.task?.mr_url ? (
          <a href={row.task.mr_url} target="_blank" rel="noreferrer" className={cx(ui.mono, styles.meta)}>
            {mrLabel(row.task.mr_url)}
          </a>
        ) : (
          <span className={styles.metaMono}>MR: chưa có</span>
        ))}

      {failed && row.task && (
        <button type="button" className={cx(ui.tag, ui.tagWarn, ui.mono)} onClick={() => onOpenTask(row.task!.task_id)} title="Mở chi tiết task">
          {row.task.fail_category ?? "failed"} · lần {row.task.attempt}
        </button>
      )}
    </li>
  );
});
