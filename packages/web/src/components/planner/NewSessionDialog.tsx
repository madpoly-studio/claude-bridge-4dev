import { useId, useState } from "react";
import type { FormEvent } from "react";
import type { RepoOption } from "@claude-bridge/protocol";
import { cx } from "../../lib/cx";
import { Modal } from "../common/Modal";
import ui from "../common/ui.module.css";
import styles from "./planner.module.css";

interface NewSessionDialogProps {
  repos: RepoOption[];
  defaultRepo?: string | null;
  onCreate: (repo: string, title?: string) => Promise<boolean>;
  onClose: () => void;
}

/** Tạo phiên planner mới: bắt buộc chọn repo trong whitelist. */
export function NewSessionDialog({ repos, defaultRepo, onCreate, onClose }: NewSessionDialogProps) {
  const id = useId();
  const [repo, setRepo] = useState(() => (defaultRepo && repos.some((r) => r.name === defaultRepo) ? defaultRepo : (repos[0]?.name ?? "")));
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!repo) {
      setError("Chọn một repo.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const ok = await onCreate(repo, title.trim() || undefined);
    setSubmitting(false);
    if (ok) onClose();
    else setError("Không tạo được phiên. Xem thông báo lỗi.");
  };

  return (
    <Modal labelledBy={`${id}-title`} onClose={onClose}>
      <form className={styles.dialogBody} onSubmit={submit}>
        <h2 id={`${id}-title`} className={styles.dialogTitle}>
          Phiên planner mới
        </h2>
        <div className={ui.field}>
          <label htmlFor={`${id}-repo`} className={ui.fieldLabel}>
            Repo
          </label>
          {repos.length === 0 ? (
            <p className={ui.empty}>Backend chưa cấu hình repo nào trong REPO_WHITELIST.</p>
          ) : (
            <select id={`${id}-repo`} data-autofocus className={cx(ui.select, ui.mono)} value={repo} onChange={(e) => setRepo(e.target.value)}>
              {repos.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                  {r.project_key ? ` (${r.project_key})` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className={ui.field}>
          <label htmlFor={`${id}-name`} className={ui.fieldLabel}>
            Tiêu đề (không bắt buộc)
          </label>
          <input id={`${id}-name`} className={ui.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ví dụ: Crash khi mở shop" />
        </div>
        {error && (
          <p className={ui.errorText} role="alert">
            {error}
          </p>
        )}
        <div className={styles.dialogActions}>
          <button type="button" className={cx(ui.btn, ui.ghost)} onClick={onClose}>
            Hủy
          </button>
          <button type="submit" className={cx(ui.btn, ui.primary)} disabled={submitting || repos.length === 0}>
            {submitting ? "Đang tạo…" : "Tạo phiên"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
