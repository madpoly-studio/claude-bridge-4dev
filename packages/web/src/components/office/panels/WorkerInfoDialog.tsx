import { useCallback, useId } from "react";
import { useNow } from "../../../hooks/useNow";
import { lastEndedAt } from "../../../state/selectors";
import { Modal } from "../../common/Modal";
import ui from "../../common/ui.module.css";
import { WorkerCard } from "../../log/WorkerCard";
import { useBridgeSelector } from "../hooks/useBridgeSelector";
import styles from "../office.module.css";

interface WorkerInfoDialogProps {
  workerId: string;
  onClose: () => void;
}

/** Thẻ thông tin của worker không có task (dùng lại nội dung WorkerCard của tab Workers). */
export function WorkerInfoDialog({ workerId, onClose }: WorkerInfoDialogProps) {
  const titleId = useId();
  const worker = useBridgeSelector(useCallback((s) => s.workers[workerId], [workerId]));
  const tasks = useBridgeSelector((s) => s.tasks);
  const now = useNow();
  const noop = useCallback(() => undefined, []);
  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <div className={styles.infoBody}>
        <div className={styles.drawerHeader}>
          <h2 id={titleId} className={styles.drawerTitle}>
            Worker
          </h2>
          <button type="button" className={ui.btn} onClick={onClose} data-autofocus>
            Đóng
          </button>
        </div>
        {worker ? (
          <WorkerCard
            worker={worker}
            task={null}
            ticketSummary={null}
            idleSince={worker.state === "idle" ? lastEndedAt(tasks, worker.worker_id) : null}
            now={now}
            onOpenTask={noop}
          />
        ) : (
          <p className={ui.empty}>Worker này không còn trong danh sách.</p>
        )}
      </div>
    </Modal>
  );
}
