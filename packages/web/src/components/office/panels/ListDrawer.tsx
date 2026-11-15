import { useId } from "react";
import { Modal } from "../../common/Modal";
import ui from "../../common/ui.module.css";
import { TicketsTab } from "../../log/TicketsTab";
import { WorkersTab } from "../../log/WorkersTab";
import styles from "../office.module.css";

interface ListDrawerProps {
  kind: "tickets" | "workers";
  onClose: () => void;
}

const TITLE = { tickets: "Tickets", workers: "Workers" } as const;

/** Drawer chứa danh sách ticket hoặc worker của dashboard (dùng lại nguyên TicketsTab / WorkersTab). */
export function ListDrawer({ kind, onClose }: ListDrawerProps) {
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} onClose={onClose} variant="drawer">
      <div className={styles.drawerHeader}>
        <h2 id={titleId} className={styles.drawerTitle}>
          {TITLE[kind]}
        </h2>
        <button type="button" className={ui.btn} onClick={onClose} data-autofocus>
          Đóng
        </button>
      </div>
      <div className={styles.drawerBody}>{kind === "tickets" ? <TicketsTab /> : <WorkersTab />}</div>
    </Modal>
  );
}
