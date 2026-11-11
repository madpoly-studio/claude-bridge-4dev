import { useId, useState } from "react";
import type { FormEvent } from "react";
import { cx } from "../../lib/cx";
import ui from "../common/ui.module.css";
import styles from "./planner.module.css";

interface PermissionDenyFormProps {
  submitting: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}

/** Hủy bản nháp kèm lý do; lý do được gửi lại cho planner để tiếp tục hội thoại. */
export function PermissionDenyForm({ submitting, onSubmit, onCancel }: PermissionDenyFormProps) {
  const id = useId();
  const [reason, setReason] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(reason.trim());
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={ui.field}>
        <label htmlFor={id} className={ui.fieldLabel}>
          Lý do hủy (gửi lại cho planner)
        </label>
        <textarea
          id={id}
          rows={3}
          className={cx(ui.input, ui.textarea)}
          placeholder="Ví dụ: chọn phương án 2, cần tách thành 2 ticket…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        />
      </div>
      <div className={styles.actions}>
        <button type="submit" className={cx(ui.btn, ui.warnOutline)} disabled={submitting}>
          {submitting ? "Đang gửi…" : "Xác nhận hủy"}
        </button>
        <button type="button" className={cx(ui.btn, ui.ghost)} onClick={onCancel} disabled={submitting}>
          Quay lại
        </button>
      </div>
    </form>
  );
}
