import { useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { cx } from "../../lib/cx";
import { applyDraftEdits, changedEdits, editsFromInput, parseLabels } from "../../state/permission-draft";
import type { DraftEdits } from "../../state/permission-draft";
import ui from "../common/ui.module.css";
import styles from "./planner.module.css";

interface PermissionEditFormProps {
  input: Record<string, unknown>;
  submitting: boolean;
  onSubmit: (updatedInput: Record<string, unknown>) => void;
  onCancel: () => void;
}

/** Sửa bản nháp: các trường chính, hoặc JSON thô khi input có shape lạ. */
export function PermissionEditForm({ input, submitting, onSubmit, onCancel }: PermissionEditFormProps) {
  const id = useId();
  const initial = useMemo(() => editsFromInput(input), [input]);
  const [summary, setSummary] = useState(initial.summary);
  const [description, setDescription] = useState(initial.description);
  const initialLabelsText = initial.labels.join(", ");
  const [labels, setLabels] = useState(initialLabelsText);
  const [rawMode, setRawMode] = useState(false);
  const [raw, setRaw] = useState(() => JSON.stringify(input, null, 2));
  const [error, setError] = useState<string | null>(null);

  /** Chỉ các trường người dùng đã đổi trên form; trường không đổi giữ nguyên giá trị/kiểu gốc trong input. */
  const formChanges = (): Partial<DraftEdits> =>
    changedEdits(initial, {
      summary,
      description,
      // Ô label chưa đụng tới thì coi như không đổi (tránh tách sai label chứa dấu phẩy).
      labels: labels === initialLabelsText ? initial.labels : parseLabels(labels),
    });

  const toggleRaw = () => {
    setError(null);
    if (!rawMode) {
      // JSON thô bắt đầu từ input gốc; chỉ mang sang các trường đã sửa trên form (nếu có).
      const changes = formChanges();
      if (Object.keys(changes).length > 0) setRaw(JSON.stringify(applyDraftEdits(input, changes), null, 2));
    }
    setRawMode((v) => !v);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (rawMode) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          setError("JSON phải là một object.");
          return;
        }
        onSubmit(parsed as Record<string, unknown>);
      } catch (err) {
        setError(`JSON không hợp lệ: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (!summary.trim()) {
      setError("Tiêu đề không được để trống.");
      return;
    }
    const changes = formChanges();
    if (changes.summary !== undefined) changes.summary = changes.summary.trim();
    onSubmit(applyDraftEdits(input, changes));
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {rawMode ? (
        <div className={ui.field}>
          <label htmlFor={`${id}-raw`} className={ui.fieldLabel}>
            Input của tool (JSON)
          </label>
          <textarea
            id={`${id}-raw`}
            className={cx(ui.input, ui.textarea, styles.jsonEditor)}
            value={raw}
            spellCheck={false}
            onChange={(e) => setRaw(e.target.value)}
          />
        </div>
      ) : (
        <>
          <div className={ui.field}>
            <label htmlFor={`${id}-summary`} className={ui.fieldLabel}>
              Tiêu đề
            </label>
            <input id={`${id}-summary`} autoFocus className={ui.input} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div className={ui.field}>
            <label htmlFor={`${id}-desc`} className={ui.fieldLabel}>
              Mô tả (giải pháp, tiêu chí nghiệm thu)
            </label>
            <textarea
              id={`${id}-desc`}
              rows={8}
              className={cx(ui.input, ui.textarea)}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className={ui.field}>
            <label htmlFor={`${id}-labels`} className={ui.fieldLabel}>
              Label (phân cách bằng dấu phẩy)
            </label>
            <input id={`${id}-labels`} className={cx(ui.input, ui.mono)} value={labels} onChange={(e) => setLabels(e.target.value)} />
          </div>
        </>
      )}
      {error && (
        <p className={ui.errorText} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button type="submit" className={cx(ui.btn, ui.primary)} disabled={submitting}>
          {submitting ? "Đang gửi…" : "Lưu và tạo ticket"}
        </button>
        <button type="button" className={ui.btn} onClick={toggleRaw} aria-pressed={rawMode}>
          {rawMode ? "Sửa theo trường" : "Sửa JSON thô"}
        </button>
        <button type="button" className={cx(ui.btn, ui.ghost)} onClick={onCancel} disabled={submitting}>
          Quay lại
        </button>
      </div>
    </form>
  );
}
