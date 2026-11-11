import { useId, useState } from "react";
import { formatClock } from "../../lib/format";
import { cx } from "../../lib/cx";
import { describeTool, summarizeToolGroup } from "../../state/stream";
import type { ToolCall } from "../../state/stream";
import { Icon } from "../common/Icon";
import styles from "./chat.module.css";

interface ToolGroupLineProps {
  calls: ToolCall[];
}

/** Các tool đọc liên tiếp gộp thành một dòng, bấm để mở danh sách. */
export function ToolGroupLine({ calls }: ToolGroupLineProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { label, detail } = summarizeToolGroup(calls);
  return (
    <>
      <button type="button" className={styles.collapsedLine} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        <Icon name="chevronRight" className={cx(styles.chevron, open && styles.chevronOpen)} />
        <span className={styles.collapsedLabel}>{label}</span>
        <span className={styles.collapsedDetail}>{detail}</span>
      </button>
      {open && (
        <ul id={listId} className={styles.expanded}>
          {calls.map((c, i) => {
            const d = describeTool(c.name, c.input);
            return (
              <li key={c.id ?? i} className={styles.expandedRow}>
                <span className={styles.expandedTime}>{formatClock(c.ts)}</span>
                <span>{d.source}</span>
                <span>{d.detail}</span>
                {c.result?.isError && <span className={styles.errorMark}>lỗi</span>}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
