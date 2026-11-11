import { useId, useMemo, useState } from "react";
import { useBridgeState } from "../../hooks/bridge-context";
import { cx } from "../../lib/cx";
import { formatClock } from "../../lib/format";
import { busEventTone, describeBusEvent } from "../../state/event-format";
import type { EventTone } from "../../state/event-format";
import { filterEvents } from "../../state/selectors";
import type { EventCategory } from "../../state/selectors";
import ui from "../common/ui.module.css";
import styles from "./log.module.css";

const CATEGORIES: Array<{ value: EventCategory; label: string }> = [
  { value: "all", label: "Tất cả" },
  { value: "task", label: "task" },
  { value: "worker", label: "worker" },
  { value: "ticket", label: "ticket" },
  { value: "errors", label: "chỉ lỗi" },
];

const TONE_CLASS: Record<EventTone, string | undefined> = {
  accent: styles.toneAccent,
  warn: styles.toneWarn,
  dim: styles.toneDim,
};

/** Số dòng render tối đa để danh sách dài không làm chậm UI. */
const MAX_VISIBLE = 300;

export function EventsTab() {
  const { events, snapshotLoaded } = useBridgeState();
  const searchId = useId();
  const [category, setCategory] = useState<EventCategory>("all");
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterEvents(events, { category, query }), [events, category, query]);
  const visible = filtered.slice(0, MAX_VISIBLE);

  return (
    <>
      <div className={styles.filters} role="group" aria-label="Lọc event">
        {CATEGORIES.map((c) => (
          <button key={c.value} type="button" className={styles.filterBtn} aria-pressed={category === c.value} onClick={() => setCategory(c.value)}>
            {c.label}
          </button>
        ))}
        <label htmlFor={searchId} className="visually-hidden">
          Lọc theo task, worker hoặc ticket
        </label>
        <input
          id={searchId}
          type="search"
          className={cx(ui.input, styles.search)}
          placeholder="task / worker / ticket ID"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {visible.length === 0 ? (
        <p className={ui.empty}>{!snapshotLoaded ? "Đang tải event…" : events.length === 0 ? "Chưa nhận event nào." : "Không có event phù hợp."}</p>
      ) : (
        <ol className={styles.eventList} aria-label="Danh sách event, mới nhất trước">
          {visible.map((ev) => (
            <li key={ev.seq} className={styles.eventRow}>
              <time className={styles.eventTime} dateTime={ev.ts}>
                {formatClock(ev.ts)}
              </time>
              <span className={cx(styles.eventType, TONE_CLASS[busEventTone(ev)])}>{ev.type}</span>
              <span className={styles.eventDetail}>{describeBusEvent(ev)}</span>
            </li>
          ))}
        </ol>
      )}
      {filtered.length > MAX_VISIBLE && (
        <span className={styles.meta}>
          Đang hiện {MAX_VISIBLE}/{filtered.length} event mới nhất. Lọc để xem event cũ hơn.
        </span>
      )}
    </>
  );
}

