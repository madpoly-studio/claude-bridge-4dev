import { useId, useState } from "react";
import { BRIDGE_EVENT_MARKER } from "@claude-bridge/protocol";
import { compactJson, formatClock, truncate } from "../../lib/format";
import { cx } from "../../lib/cx";
import { wakeEventTypes } from "../../state/stream";
import type { SystemTurn } from "../../state/stream";
import { Icon } from "../common/Icon";
import styles from "./chat.module.css";

interface SystemTurnsLineProps {
  turns: SystemTurn[];
}

const RAW_TURN_MAX = 200;

function turnSummary(turn: SystemTurn): string {
  if (!turn.events) return truncate(turn.text.replace(BRIDGE_EVENT_MARKER, "").trim(), RAW_TURN_MAX);
  return turn.events
    .map((e) => {
      const { type, ...rest } = e;
      const ids = Object.values(rest).filter(Boolean).join(" ");
      return ids ? `${type} ${ids}` : type;
    })
    .join(" · ");
}

/** Turn hệ thống ([bridge-event]) liên tiếp gộp thành một dòng mờ. */
export function SystemTurnsLine({ turns }: SystemTurnsLineProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <>
      <button type="button" className={styles.collapsedLine} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        <Icon name="chevronRight" className={cx(styles.chevron, open && styles.chevronOpen)} />
        <span className={styles.collapsedLabel}>{turns.length} turn hệ thống</span>
        <span className={styles.collapsedDetail}>{wakeEventTypes(turns).join(", ")}</span>
      </button>
      {open && (
        <ul id={listId} className={styles.expanded}>
          {turns.map((t) => (
            <li key={t.key} className={styles.expandedRow} title={compactJson(t.events ?? t.text, 500)}>
              <span className={styles.expandedTime}>{formatClock(t.ts)}</span>
              <span>{turnSummary(t)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
