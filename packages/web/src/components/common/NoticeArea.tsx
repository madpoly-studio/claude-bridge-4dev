import { useCallback, useEffect } from "react";
import { NOTICE_TIMEOUT_MS } from "../../config";
import { useBridgeActions, useBridgeState } from "../../hooks/bridge-context";
import type { Notice } from "../../state/types";
import { cx } from "../../lib/cx";
import { Icon } from "./Icon";
import styles from "./notice.module.css";

function NoticeItem({ notice, onDismiss }: { notice: Notice; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(notice.id), NOTICE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [notice.id, onDismiss]);

  return (
    <div className={cx(styles.notice, notice.kind === "error" && styles.error)} role={notice.kind === "error" ? "alert" : "status"}>
      <span className={styles.kind}>{notice.kind === "error" ? "Lỗi" : "Thông báo"}</span>
      <span className={styles.text}>{notice.text}</span>
      <button type="button" className={styles.close} aria-label="Đóng thông báo" onClick={() => onDismiss(notice.id)}>
        <Icon name="close" />
      </button>
    </div>
  );
}

/** Thông báo nổi tạm thời (lỗi request, thông tin demo). */
export function NoticeArea() {
  const { notices } = useBridgeState();
  const actions = useBridgeActions();
  const dismiss = useCallback((id: string) => actions.dismissNotice(id), [actions]);
  return (
    <div className={styles.area} aria-live="polite">
      {notices.map((n) => (
        <NoticeItem key={n.id} notice={n} onDismiss={dismiss} />
      ))}
    </div>
  );
}
