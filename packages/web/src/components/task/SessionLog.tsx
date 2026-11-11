import { useMemo } from "react";
import type { SessionEventRecord } from "@claude-bridge/protocol";
import { cx } from "../../lib/cx";
import { formatClock } from "../../lib/format";
import { buildLogRows } from "../../state/stream";
import type { LogTone } from "../../state/stream";
import ui from "../common/ui.module.css";
import styles from "./task.module.css";

interface SessionLogProps {
  records: SessionEventRecord[];
  loaded: boolean;
  /** Có event cũ hơn đã bị ẩn. */
  truncated?: boolean;
}

const TRUNCATED_TEXT = "Đã ẩn các sự kiện cũ hơn";

const TONE_CLASS: Record<LogTone, string | undefined> = {
  accent: styles.toneAccent,
  dim: styles.toneDim,
  warn: styles.toneWarn,
  normal: styles.toneNormal,
};

/** Luồng session của worker dạng bảng thời gian · nguồn · chi tiết. Chỉ xem. */
export function SessionLog({ records, loaded, truncated = false }: SessionLogProps) {
  const rows = useMemo(() => buildLogRows(records), [records]);

  if (!loaded && rows.length === 0) return <p className={ui.empty}>Đang tải luồng session…</p>;
  if (rows.length === 0) return <p className={ui.empty}>Worker chưa có hoạt động.</p>;

  return (
    <>
      {truncated && <p className={styles.truncated}>{TRUNCATED_TEXT}</p>}
      <ol className={styles.log} aria-label="Luồng session của worker">
      {rows.map((r) => (
        <li key={r.key} className={styles.logRow}>
          <time className={styles.logTime} dateTime={r.ts}>
            {formatClock(r.ts)}
          </time>
          <span className={cx(styles.logSource, r.tone === "accent" ? styles.toneAccent : styles.toneDim)}>{r.source}</span>
          <span className={cx(styles.logDetail, TONE_CLASS[r.tone])}>{r.detail}</span>
        </li>
      ))}
      </ol>
    </>
  );
}
