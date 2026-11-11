import { useMemo } from "react";
import type { ReactNode } from "react";
import type { SessionEventRecord } from "@claude-bridge/protocol";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import { buildStreamItems } from "../../state/stream";
import type { BuildOptions } from "../../state/stream";
import columnStyles from "../common/column.module.css";
import { StreamItemView } from "./StreamItemView";
import styles from "./chat.module.css";

interface ChatStreamProps {
  records: SessionEventRecord[];
  loaded: boolean;
  speaker: string;
  options: BuildOptions;
  emptyText: string;
  ariaLabel: string;
  /** Nội dung cuối luồng (card duyệt, trạng thái đang trả lời). */
  footer?: ReactNode;
}

const AGENT_KINDS = new Set(["agent", "tool"]);

export function ChatStream({ records, loaded, speaker, options, emptyText, ariaLabel, footer }: ChatStreamProps) {
  const items = useMemo(() => buildStreamItems(records, options), [records, options]);
  const { ref, onScroll } = useAutoScroll<HTMLDivElement>(`${items.length}:${footer ? 1 : 0}`);

  return (
    <div ref={ref} className={columnStyles.body} onScroll={onScroll}>
      <div className={styles.stream} role="log" aria-label={ariaLabel} aria-live="polite" aria-relevant="additions">
        {!loaded && records.length === 0 && <p className={styles.state}>Đang tải lịch sử…</p>}
        {loaded && items.length === 0 && <p className={styles.state}>{emptyText}</p>}
        {items.map((item, i) => {
          const prev = items[i - 1];
          const showSpeaker = AGENT_KINDS.has(item.kind) && !(prev && AGENT_KINDS.has(prev.kind));
          return <StreamItemView key={item.key} item={item} speaker={speaker} showSpeaker={showSpeaker} />;
        })}
        {footer}
      </div>
    </div>
  );
}
