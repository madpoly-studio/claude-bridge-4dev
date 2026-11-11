import { useId, useMemo, useState } from "react";
import type { PermissionRequest } from "@claude-bridge/protocol";
import { useBridgeActions } from "../../hooks/bridge-context";
import { cx } from "../../lib/cx";
import { draftFromInput } from "../../state/permission-draft";
import type { PermissionResponse } from "../../services/bridge-actions";
import ui from "../common/ui.module.css";
import { PermissionDenyForm } from "./PermissionDenyForm";
import { PermissionEditForm } from "./PermissionEditForm";
import styles from "./planner.module.css";

interface PermissionCardProps {
  request: PermissionRequest;
}

type Mode = "view" | "edit" | "deny";

/** Card bản nháp ticket chờ duyệt (gate "chốt solution", mục 5.3). */
export function PermissionCard({ request }: PermissionCardProps) {
  const actions = useBridgeActions();
  const titleId = useId();
  const [mode, setMode] = useState<Mode>("view");
  const [submitting, setSubmitting] = useState(false);
  const draft = useMemo(() => draftFromInput(request.input), [request.input]);
  const recognized = Boolean(draft.title || draft.description || draft.solution);

  const respond = async (response: Omit<PermissionResponse, "request_id">) => {
    setSubmitting(true);
    const ok = await actions.respondPermission({ request_id: request.request_id, ...response });
    setSubmitting(false);
    if (ok) setMode("view");
  };

  const solution = draft.solution ?? draft.description;

  return (
    <article className={styles.card} aria-labelledby={titleId}>
      <div className={styles.cardHeader}>
        <h3 id={titleId} className={styles.cardTitle}>
          Bản nháp ticket
        </h3>
        <span className={cx(ui.tag, ui.tagWarn)}>Chờ duyệt</span>
        <span className={styles.spacer} />
        {draft.type && <span className={ui.tag}>{draft.type}</span>}
        {draft.project && <span className={cx(ui.tag, ui.mono)}>{draft.project}</span>}
        {draft.labels.map((l) => (
          <span key={l} className={cx(ui.tag, ui.mono)}>
            label: {l}
          </span>
        ))}
      </div>

      {mode === "edit" ? (
        <PermissionEditForm
          input={request.input}
          submitting={submitting}
          onCancel={() => setMode("view")}
          onSubmit={(updated_input) => void respond({ decision: "allow", updated_input })}
        />
      ) : (
        <>
          {draft.title && <div className={styles.draftTitle}>{draft.title}</div>}
          {solution && (
            <div className={styles.section}>
              <span className={ui.fieldLabel}>Giải pháp</span>
              <span className={styles.sectionText}>{solution}</span>
            </div>
          )}
          {draft.acceptance.length > 0 && (
            <div className={styles.section}>
              <span className={ui.fieldLabel}>Tiêu chí nghiệm thu</span>
              <ul className={styles.criteria}>
                {draft.acceptance.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {!recognized && (
            <div className={styles.section}>
              <span className={ui.fieldLabel}>Input của tool</span>
              <pre className={cx(styles.sectionText, ui.mono)}>{JSON.stringify(request.input, null, 2)}</pre>
            </div>
          )}
          <span className={styles.toolName}>{request.tool}</span>

          {mode === "deny" ? (
            <PermissionDenyForm
              submitting={submitting}
              onCancel={() => setMode("view")}
              onSubmit={(reason) => void respond({ decision: "deny", reason: reason || undefined })}
            />
          ) : (
            <div className={styles.actions}>
              <button type="button" className={cx(ui.btn, ui.primary)} disabled={submitting} onClick={() => void respond({ decision: "allow" })}>
                {submitting ? "Đang gửi…" : "Duyệt và tạo ticket"}
              </button>
              <button type="button" className={ui.btn} disabled={submitting} onClick={() => setMode("edit")}>
                Sửa
              </button>
              <button type="button" className={cx(ui.btn, ui.ghost)} disabled={submitting} onClick={() => setMode("deny")}>
                Hủy
              </button>
            </div>
          )}
        </>
      )}
    </article>
  );
}
