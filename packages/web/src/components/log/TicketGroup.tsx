import { useId } from "react";
import type { TicketRow } from "../../state/selectors";
import ui from "../common/ui.module.css";
import { TicketRowView } from "./TicketRowView";
import type { TicketGroupKind } from "./TicketRowView";
import styles from "./log.module.css";

interface TicketGroupProps {
  kind: TicketGroupKind;
  title: string;
  empty: string;
  rows: TicketRow[];
  onOpenTask: (taskId: string) => void;
}

export function TicketGroup({ kind, title, empty, rows, onOpenTask }: TicketGroupProps) {
  const headingId = useId();
  return (
    <section className={styles.group} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.groupTitle}>
        {title} · {rows.length}
      </h3>
      {rows.length === 0 ? (
        <p className={ui.empty}>{empty}</p>
      ) : (
        <ul className={styles.ticketList}>
          {rows.map((r) => (
            <TicketRowView key={r.key} row={r} group={kind} onOpenTask={onOpenTask} />
          ))}
        </ul>
      )}
    </section>
  );
}
