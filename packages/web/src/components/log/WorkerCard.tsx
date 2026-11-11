import { memo } from "react";
import type { Task, Worker } from "@claude-bridge/protocol";
import { cx } from "../../lib/cx";
import { basename, durationBetween, elapsedSince, formatDuration, formatHourMinute } from "../../lib/format";
import { WORKER_STATE_LABEL } from "../../state/event-format";
import { PhaseBar } from "../common/PhaseBar";
import ui from "../common/ui.module.css";
import styles from "./log.module.css";

interface WorkerCardProps {
  worker: Worker;
  task: Task | null;
  ticketSummary: string | null;
  idleSince: string | null;
  now: number;
  onOpenTask: (taskId: string) => void;
}

const BADGE_CLASS: Record<Worker["state"], string | undefined> = {
  busy: ui.badgeAccent,
  idle: ui.badgeOk,
  offline: ui.badgeOffline,
};

function timeLabel(worker: Worker, task: Task | null, idleSince: string | null, now: number): string {
  if (worker.state === "offline") {
    return worker.last_heartbeat ? `mất heartbeat từ ${formatHourMinute(worker.last_heartbeat)}` : "chưa có heartbeat";
  }
  if (worker.state === "busy" && task) {
    const ms = durationBetween(task.started_at ?? task.assigned_at, null, now);
    return ms === null ? "" : formatDuration(ms);
  }
  const idle = elapsedSince(idleSince, now);
  return idle === null ? "rảnh" : `rảnh ${formatDuration(idle)}`;
}

/** Thẻ worker: trạng thái luôn có nhãn chữ BUSY / IDLE / OFFLINE. */
export const WorkerCard = memo(function WorkerCard({ worker, task, ticketSummary, idleSince, now, onOpenTask }: WorkerCardProps) {
  const offline = worker.state === "offline";
  const content = (
    <>
      <span className={styles.row}>
        <span className={cx(styles.workerId, offline && styles.workerIdOffline)}>{worker.worker_id}</span>
        <span className={cx(ui.badge, BADGE_CLASS[worker.state])}>{WORKER_STATE_LABEL[worker.state]}</span>
        <span className={styles.spacer} />
        <span className={styles.meta}>{timeLabel(worker, task, idleSince, now)}</span>
      </span>
      {task && (
        <>
          <span className={styles.ticketLine}>
            <span className={styles.ticketKey}>{task.ticket_key}</span>
            {ticketSummary && <span>{ticketSummary}</span>}
            {task.state === "assigned" && <span className={ui.tag}>chờ runner khởi động</span>}
          </span>
          <PhaseBar phase={task.phase} />
        </>
      )}
      <span className={styles.metaMono}>
        {worker.repo} · {basename(worker.worktree_path)}
      </span>
    </>
  );

  if (task) {
    return (
      <button
        type="button"
        className={styles.workerCard}
        onClick={() => onOpenTask(task.task_id)}
        aria-label={`${worker.worker_id}, ${WORKER_STATE_LABEL[worker.state]}, ${task.ticket_key}. Mở chi tiết task`}
      >
        {content}
      </button>
    );
  }
  return <div className={cx(styles.workerCard, offline && styles.workerOffline)}>{content}</div>;
});
