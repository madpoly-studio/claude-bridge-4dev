import { useCallback, useMemo } from "react";
import { useBridgeActions, useBridgeState } from "../../hooks/bridge-context";
import { groupTickets } from "../../state/selectors";
import ui from "../common/ui.module.css";
import { TicketGroup } from "./TicketGroup";
import type { TicketGroupKind } from "./TicketRowView";
import styles from "./log.module.css";

const GROUPS: Array<{ kind: TicketGroupKind; title: string; empty: string }> = [
  { kind: "waiting", title: "CHỜ GIAO", empty: "Không có ticket chờ giao." },
  { kind: "inProgress", title: "ĐANG LÀM", empty: "Không có ticket đang làm." },
  { kind: "review", title: "CHỜ REVIEW", empty: "Không có ticket chờ review." },
  { kind: "failed", title: "LỖI", empty: "Không có ticket lỗi." },
];

export function TicketsTab() {
  const { tickets, tasks, snapshotLoaded, status } = useBridgeState();
  const actions = useBridgeActions();
  const openTask = useCallback((taskId: string) => void actions.openTask(taskId), [actions]);
  const groups = useMemo(() => groupTickets(tickets, tasks), [tickets, tasks]);

  if (!snapshotLoaded) return <p className={ui.empty}>Đang tải danh sách ticket…</p>;

  return (
    <div className={styles.groups}>
      {status?.jira === "unconfigured" && <p className={ui.empty}>Backend chưa cấu hình Jira; danh sách ticket chỉ gồm các task đã biết.</p>}
      {status?.jira === "error" && (
        <p className={ui.errorText} role="alert">
          Lỗi đọc Jira: danh sách ticket có thể chưa cập nhật.
        </p>
      )}
      {GROUPS.map((g) => (
        <TicketGroup key={g.kind} kind={g.kind} title={g.title} empty={g.empty} rows={groups[g.kind]} onOpenTask={openTask} />
      ))}
    </div>
  );
}
