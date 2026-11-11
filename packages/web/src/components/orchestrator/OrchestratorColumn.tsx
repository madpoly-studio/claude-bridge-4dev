import { useMemo } from "react";
import { useBridgeActions, useBridgeState } from "../../hooks/bridge-context";
import { cx } from "../../lib/cx";
import { formatHourMinute } from "../../lib/format";
import { orchestratorSession, sessionStream } from "../../state/selectors";
import type { BuildOptions } from "../../state/stream";
import { ChatInput } from "../chat/ChatInput";
import { ChatStream } from "../chat/ChatStream";
import chatStyles from "../chat/chat.module.css";
import columnStyles from "../common/column.module.css";
import ui from "../common/ui.module.css";

const STREAM_OPTIONS: BuildOptions = { collapseReadOnly: false };

/** ts của turn hệ thống gần nhất (lần bridge đánh thức orchestrator). */
function lastSystemTurnTs(records: { origin: string; ts: string }[]): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]!.origin === "system") return records[i]!.ts;
  }
  return null;
}

export function OrchestratorColumn() {
  const state = useBridgeState();
  const actions = useBridgeActions();
  const session = orchestratorSession(state);
  const stream = sessionStream(state, session?.session_id ?? null);
  const lastWake = useMemo(() => lastSystemTurnTs(stream.records), [stream.records]);
  const project = state.status?.project_key ?? session?.project_key ?? null;
  const health = state.status?.orchestrator;

  const connected = state.connection.phase === "live" || state.connection.phase === "syncing";
  const unavailable = health === "dead" || health === "stopped";
  const disabledReason = !connected
    ? "Chưa kết nối backend."
    : !session
      ? "Chưa có session orchestrator cho project này."
      : unavailable
        ? "Orchestrator không chạy."
        : undefined;

  return (
    <section aria-label="Orchestrator" className={columnStyles.column}>
      <div className={columnStyles.header}>
        <h2 className={columnStyles.title}>Orchestrator</h2>
        {project && <span className={cx(ui.tag, ui.mono)}>project {project}</span>}
        <span className={columnStyles.spacer} />
        {lastWake && <span className={columnStyles.meta}>Lần quét gần nhất {formatHourMinute(lastWake)}</span>}
      </div>

      {session ? (
        <ChatStream
          records={stream.records}
          loaded={stream.loaded}
          speaker="orchestrator"
          options={STREAM_OPTIONS}
          emptyText="Orchestrator chưa có hoạt động."
          ariaLabel="Hội thoại orchestrator"
          footer={
            session.busy ? (
              <span className={chatStyles.busy} role="status">
                Orchestrator đang xử lý…
              </span>
            ) : null
          }
        />
      ) : (
        <div className={columnStyles.body}>
          <div className={chatStyles.stream}>
            <p className={chatStyles.state}>
              {state.snapshotLoaded ? "Chưa có session orchestrator cho project này." : "Đang chờ dữ liệu từ backend…"}
            </p>
          </div>
        </div>
      )}

      <div className={columnStyles.footer}>
        <ChatInput
          label="Nhắn cho orchestrator"
          placeholder="Ra lệnh hoặc hỏi tình hình"
          disabled={!!disabledReason}
          disabledReason={disabledReason}
          busy={session?.busy ?? false}
          onSend={(text) => (session ? actions.sendMessage(session.session_id, text) : Promise.resolve(false))}
          onInterrupt={() => (session ? actions.interrupt(session.session_id) : Promise.resolve(false))}
        />
      </div>
    </section>
  );
}
