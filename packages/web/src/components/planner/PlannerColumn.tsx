import { useId, useMemo, useState } from "react";
import type { Session, SessionState } from "@claude-bridge/protocol";
import { useBridgeActions, useBridgeState } from "../../hooks/bridge-context";
import { cx } from "../../lib/cx";
import { plannerSessions, sessionStream } from "../../state/selectors";
import type { BuildOptions } from "../../state/stream";
import { ChatInput } from "../chat/ChatInput";
import { ChatStream } from "../chat/ChatStream";
import chatStyles from "../chat/chat.module.css";
import columnStyles from "../common/column.module.css";
import { Icon } from "../common/Icon";
import ui from "../common/ui.module.css";
import { NewSessionDialog } from "./NewSessionDialog";
import { PermissionCard } from "./PermissionCard";
import styles from "./planner.module.css";

const STREAM_OPTIONS: BuildOptions = { collapseReadOnly: true };

const SESSION_STATE_LABEL: Record<SessionState, string> = {
  starting: "đang khởi động",
  active: "đang mở",
  detached: "chờ resume",
  closed: "đã đóng",
  error: "lỗi",
};

function sessionLabel(s: Session): string {
  const name = s.title || `Phiên ${s.session_id.slice(0, 8)}`;
  return s.state === "active" ? name : `${name} (${SESSION_STATE_LABEL[s.state]})`;
}

export function PlannerColumn() {
  const state = useBridgeState();
  const actions = useBridgeActions();
  const selectId = useId();
  const [dialogOpen, setDialogOpen] = useState(false);

  const sessions = plannerSessions(state);
  const current = state.plannerSessionId ? (state.sessions[state.plannerSessionId] ?? null) : null;
  const stream = sessionStream(state, current?.session_id ?? null);
  const pending = useMemo(() => Object.values(state.permissions), [state.permissions]);
  const pendingHere = pending.filter((p) => p.session_id === current?.session_id);
  const pendingElsewhere = pending.filter((p) => p.session_id !== current?.session_id && state.sessions[p.session_id]?.role !== "orchestrator");

  const connected = state.connection.phase === "live" || state.connection.phase === "syncing";
  const inputDisabled = !connected || !current || current.state === "closed" || current.state === "error";
  const disabledReason = !connected
    ? "Chưa kết nối backend."
    : !current
      ? "Chọn hoặc tạo một phiên planner."
      : current.state === "closed"
        ? "Phiên đã đóng. Tạo phiên mới để tiếp tục."
        : current.state === "error"
          ? "Phiên lỗi. Tạo phiên mới để tiếp tục."
          : undefined;

  const footer = (
    <>
      {current?.busy && (
        <span className={chatStyles.busy} role="status">
          Planner đang trả lời…
        </span>
      )}
      {pendingHere.map((p) => (
        <PermissionCard key={p.request_id} request={p} />
      ))}
      {pendingElsewhere.length > 0 && (
        <div className={styles.otherPending} role="status">
          <span>Có {pendingElsewhere.length} bản nháp chờ duyệt ở phiên khác.</span>
          <button
            type="button"
            className={cx(ui.btn, ui.small)}
            onClick={() => void actions.selectPlannerSession(pendingElsewhere[0]!.session_id)}
          >
            Mở phiên đó
          </button>
        </div>
      )}
    </>
  );

  return (
    <section aria-label="Planner" className={columnStyles.column}>
      <div className={columnStyles.header}>
        <h2 className={columnStyles.title}>Planner</h2>
        {current?.repo && <span className={cx(ui.tag, styles.repoTag)}>{current.repo}</span>}
        <span className={columnStyles.spacer} />
        <label htmlFor={selectId} className="visually-hidden">
          Chọn phiên planner
        </label>
        <select
          id={selectId}
          className={cx(ui.select, styles.sessionSelect)}
          value={current?.session_id ?? ""}
          disabled={sessions.length === 0}
          onChange={(e) => void actions.selectPlannerSession(e.target.value)}
        >
          {sessions.length === 0 && <option value="">Chưa có phiên</option>}
          {!current && sessions.length > 0 && <option value="">Chọn phiên…</option>}
          {sessions.map((s) => (
            <option key={s.session_id} value={s.session_id}>
              {sessionLabel(s)}
            </option>
          ))}
        </select>
        <button type="button" className={cx(ui.btn, ui.accentGhost, ui.small)} onClick={() => setDialogOpen(true)} disabled={!connected}>
          <Icon name="plus" />
          Phiên mới
        </button>
      </div>

      {current ? (
        <ChatStream
          records={stream.records}
          loaded={stream.loaded}
          speaker="planner"
          options={STREAM_OPTIONS}
          emptyText="Phiên chưa có tin nhắn. Mô tả vấn đề để bắt đầu."
          ariaLabel="Hội thoại planner"
          footer={footer}
        />
      ) : (
        <div className={columnStyles.body}>
          <div className={chatStyles.stream}>
            <p className={chatStyles.state}>Chưa có phiên planner. Bấm Phiên mới để bắt đầu.</p>
            {footer}
          </div>
        </div>
      )}

      <div className={columnStyles.footer}>
        <ChatInput
          label="Nhắn cho planner"
          placeholder="Mô tả vấn đề hoặc trả lời planner"
          disabled={inputDisabled}
          disabledReason={disabledReason}
          busy={current?.busy ?? false}
          onSend={(text) => (current ? actions.sendMessage(current.session_id, text) : Promise.resolve(false))}
          onInterrupt={() => (current ? actions.interrupt(current.session_id) : Promise.resolve(false))}
        />
      </div>

      {dialogOpen && (
        <NewSessionDialog
          repos={state.repos}
          defaultRepo={current?.repo}
          onCreate={(repo, title) => actions.createPlannerSession(repo, title)}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </section>
  );
}
