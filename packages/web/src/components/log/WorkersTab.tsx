import { useCallback } from "react";
import { useBridgeActions, useBridgeState } from "../../hooks/bridge-context";
import { useNow } from "../../hooks/useNow";
import { lastEndedAt, sortedWorkers } from "../../state/selectors";
import ui from "../common/ui.module.css";
import { WorkerCard } from "./WorkerCard";
import styles from "./log.module.css";

export function WorkersTab() {
  const { workers, tasks, tickets, snapshotLoaded } = useBridgeState();
  const actions = useBridgeActions();
  const now = useNow();
  const openTask = useCallback((taskId: string) => void actions.openTask(taskId), [actions]);
  const list = sortedWorkers(workers);

  if (!snapshotLoaded) return <p className={ui.empty}>Đang tải danh sách worker…</p>;
  if (list.length === 0) return <p className={ui.empty}>Chưa có worker nào đăng ký. Khởi động runner để thêm worker.</p>;

  return (
    <>
      {list.map((w) => {
        const task = w.current_task_id ? (tasks[w.current_task_id] ?? null) : null;
        const summary = task ? (tickets.find((t) => t.key === task.ticket_key)?.summary ?? task.summary) : null;
        return (
          <WorkerCard
            key={w.worker_id}
            worker={w}
            task={task}
            ticketSummary={summary}
            idleSince={w.state === "idle" ? lastEndedAt(tasks, w.worker_id) : null}
            now={now}
            onOpenTask={openTask}
          />
        );
      })}
      <span className={styles.meta}>Bấm vào worker đang chạy để xem chi tiết task.</span>
    </>
  );
}
