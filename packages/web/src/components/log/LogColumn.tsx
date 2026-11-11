import { useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { STORAGE_KEYS } from "../../config";
import { useBridgeState } from "../../hooks/bridge-context";
import { cx } from "../../lib/cx";
import { readStorage, writeStorage } from "../../lib/storage";
import { groupTickets } from "../../state/selectors";
import columnStyles from "../common/column.module.css";
import { EventsTab } from "./EventsTab";
import { TicketsTab } from "./TicketsTab";
import { WorkersTab } from "./WorkersTab";
import styles from "./log.module.css";

type LogTab = "workers" | "tickets" | "events";

const TABS: Array<{ id: LogTab; label: string }> = [
  { id: "workers", label: "Workers" },
  { id: "tickets", label: "Tickets" },
  { id: "events", label: "Events" },
];

function initialTab(): LogTab {
  const saved = readStorage(STORAGE_KEYS.logTab);
  return TABS.some((t) => t.id === saved) ? (saved as LogTab) : "workers";
}

export function LogColumn() {
  const baseId = useId();
  const [tab, setTab] = useState<LogTab>(initialTab);
  const tabRefs = useRef<Record<LogTab, HTMLButtonElement | null>>({ workers: null, tickets: null, events: null });
  const state = useBridgeState();

  const failedCount = groupTickets(state.tickets, state.tasks).failed.length;
  const counts: Record<LogTab, string | null> = {
    workers: String(Object.keys(state.workers).length),
    tickets: failedCount > 0 ? `${failedCount} lỗi` : null,
    events: null,
  };

  const select = (next: LogTab) => {
    setTab(next);
    writeStorage(STORAGE_KEYS.logTab, next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = TABS.findIndex((t) => t.id === tab);
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % TABS.length;
    else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = TABS.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const next = TABS[nextIdx]!.id;
    select(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <section aria-label="Log" className={columnStyles.column}>
      <div className={styles.tabs} role="tablist" aria-label="Log" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${baseId}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            className={cx(styles.tab, tab === t.id && styles.tabActive)}
            onClick={() => select(t.id)}
          >
            {t.label}
            {counts[t.id] && <span className={styles.count}>{counts[t.id]}</span>}
          </button>
        ))}
      </div>
      <div className={columnStyles.body}>
        <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab}`} className={styles.panel}>
          {tab === "workers" && <WorkersTab />}
          {tab === "tickets" && <TicketsTab />}
          {tab === "events" && <EventsTab />}
        </div>
      </div>
    </section>
  );
}
