import { useId } from "react";
import type { TaskState } from "@claude-bridge/protocol";
import { useBridgeActions, useBridgeState } from "../../hooks/bridge-context";
import { useNow } from "../../hooks/useNow";
import { cx } from "../../lib/cx";
import { basename, durationBetween, formatClock, formatDuration, formatTokens, mrLabel } from "../../lib/format";
import { TASK_STATE_LABEL } from "../../state/event-format";
import { taskStream, ticketUrl, totalTokens } from "../../state/selectors";
import { ExternalLink } from "../common/ExternalLink";
import { Modal } from "../common/Modal";
import { PhaseBar } from "../common/PhaseBar";
import ui from "../common/ui.module.css";
import { SessionLog } from "./SessionLog";
import styles from "./task.module.css";

const STATE_BADGE: Record<TaskState, string | undefined> = {
  assigned: ui.badgeOk,
  running: ui.badgeAccent,
  completed: ui.badgeOk,
  failed: ui.badgeWarn,
  cancelled: ui.badgeOffline,
};

/** Panel chi tiết task (chỉ xem). */
export function TaskDetailPanel({ taskId }: { taskId: string }) {
  const state = useBridgeState();
  const actions = useBridgeActions();
  const titleId = useId();
  const now = useNow();
  const close = () => void actions.openTask(null);

  const task = state.tasks[taskId];
  if (!task) {
    return (
      <Modal labelledBy={titleId} onClose={close} variant="drawer">
        <div className={styles.header}>
          <h2 id={titleId} className={styles.key}>
            {taskId}
          </h2>
          <span className={styles.spacer} />
          <button type="button" className={ui.btn} onClick={close}>
            Đóng
          </button>
        </div>
        <p className={cx(ui.empty, styles.body)}>Không tìm thấy task này trong snapshot hiện tại.</p>
      </Modal>
    );
  }

  const worker = state.workers[task.worker_id];
  const ticket = state.tickets.find((t) => t.key === task.ticket_key);
  const jiraUrl = ticketUrl(task.ticket_key, state.tickets);
  const stream = taskStream(state, taskId);
  const tokens = totalTokens(task.usage);
  const duration = durationBetween(task.started_at ?? task.assigned_at, task.ended_at, now);
  const startedAt = task.started_at ?? task.assigned_at;

  return (
    <Modal labelledBy={titleId} onClose={close} variant="drawer">
      <div className={styles.header}>
        <h2 id={titleId} className={styles.key}>
          {task.ticket_key}
        </h2>
        <span className={cx(ui.badge, STATE_BADGE[task.state])}>{TASK_STATE_LABEL[task.state]}</span>
        <span className={styles.spacer} />
        <button type="button" className={ui.btn} onClick={close} data-autofocus>
          Đóng
        </button>
      </div>

      <div className={styles.body}>
        <div className={styles.title}>{ticket?.summary ?? task.summary ?? task.task_id}</div>

        <dl className={styles.grid}>
          <div className={styles.cell}>
            <dt>Worker</dt>
            <dd>{task.worker_id}</dd>
          </div>
          <div className={styles.cell}>
            <dt>Worktree</dt>
            <dd>{worker ? `${worker.repo} · ${basename(worker.worktree_path)}` : "—"}</dd>
          </div>
          <div className={styles.cell}>
            <dt>{task.started_at ? "Bắt đầu" : "Giao lúc"}</dt>
            <dd>
              {formatClock(startedAt)}
              {duration !== null && ` · ${formatDuration(duration)}`}
            </dd>
          </div>
          <div className={styles.cell}>
            <dt>Lần thử</dt>
            <dd>{task.attempt}</dd>
          </div>
          <div className={styles.cell}>
            <dt>Branch</dt>
            <dd>{task.branch ?? "—"}</dd>
          </div>
          <div className={styles.cell}>
            <dt>Token đã dùng</dt>
            <dd>
              {tokens !== null ? formatTokens(tokens) : "—"}
              {typeof task.usage?.total_cost_usd === "number" && ` · $${task.usage.total_cost_usd.toFixed(2)}`}
            </dd>
          </div>
        </dl>

        <div className={styles.section}>
          <span className={ui.sectionLabel}>Tiến độ</span>
          <PhaseBar phase={task.phase} variant="labeled" failed={task.state === "failed"} />
        </div>

        {(task.state === "failed" || task.state === "cancelled") && (
          <div className={styles.failBox} role="note">
            <span className={styles.failTitle}>
              {task.state === "failed" ? `task.failed · ${task.fail_category ?? "không rõ"}` : "task.cancelled"}
            </span>
            {task.fail_reason && <span>{task.fail_reason}</span>}
          </div>
        )}

        {task.summary && task.state === "completed" && <p className={styles.note}>{task.summary}</p>}

        <div className={styles.links}>
          <ExternalLink href={jiraUrl} className={ui.btn} fallback={<span className={styles.placeholderLink}>Jira: chưa biết URL</span>}>
            Mở ticket trên Jira
          </ExternalLink>
          {task.mr_url ? (
            <ExternalLink
              href={task.mr_url}
              className={ui.btn}
              fallback={<span className={styles.placeholderLink}>Merge request (link không hợp lệ): {task.mr_url}</span>}
            >
              Merge request {mrLabel(task.mr_url).replace(/^MR\s*/, "")}
            </ExternalLink>
          ) : (
            <span className={styles.placeholderLink}>Merge request: chưa có</span>
          )}
        </div>

        <div className={styles.section}>
          <span className={ui.sectionLabel}>Luồng session</span>
          <SessionLog records={stream.records} loaded={stream.loaded} truncated={stream.truncated} />
          <span className={styles.note}>Chỉ xem. Lệnh cho worker đi qua orchestrator.</span>
        </div>
      </div>
    </Modal>
  );
}
