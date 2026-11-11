import { useId, useState } from "react";
import type { OrchestratorHealth } from "@claude-bridge/protocol";
import { useBridgeActions, useBridgeState, useIsDemo } from "../../hooks/bridge-context";
import { useNow } from "../../hooks/useNow";
import { cx } from "../../lib/cx";
import { notificationState, requestNotificationPermission } from "../../services/notifier";
import type { NotificationState } from "../../services/notifier";
import { ORCHESTRATOR_LABEL } from "../../state/event-format";
import type { ConnectionPhase } from "../../ws/client";
import { Icon } from "../common/Icon";
import ui from "../common/ui.module.css";
import { SeatChip } from "./SeatChip";
import { StatusChip } from "./StatusChip";
import type { ChipTone } from "./StatusChip";
import styles from "./topbar.module.css";

interface TopBarProps {
  onOpenConnection: () => void;
}

const BACKEND_CHIP: Record<ConnectionPhase, { text: string; tone: ChipTone }> = {
  idle: { text: "chưa kết nối", tone: "off" },
  connecting: { text: "đang kết nối", tone: "warn" },
  authenticating: { text: "đang xác thực", tone: "warn" },
  syncing: { text: "đang replay", tone: "warn" },
  live: { text: "đã kết nối", tone: "ok" },
  reconnecting: { text: "mất kết nối", tone: "danger" },
  auth_failed: { text: "token sai", tone: "danger" },
  origin_rejected: { text: "origin bị chặn", tone: "danger" },
  stopped: { text: "đã ngắt", tone: "off" },
};

const ORCH_TONE: Record<OrchestratorHealth, ChipTone> = {
  alive: "ok",
  restarting: "warn",
  dead: "danger",
  stopped: "off",
};

export function TopBar({ onOpenConnection }: TopBarProps) {
  const state = useBridgeState();
  const actions = useBridgeActions();
  const demo = useIsDemo();
  const projectId = useId();
  const now = useNow();
  const [notif, setNotif] = useState<NotificationState>(notificationState);
  const [toggling, setToggling] = useState(false);
  const status = state.status;
  const connected = state.connection.phase === "live" || state.connection.phase === "syncing";

  const backend = demo ? { text: "demo", tone: "ok" as ChipTone } : BACKEND_CHIP[state.connection.phase];
  const projects = state.projects.length > 0 ? state.projects : status?.project_key ? [status.project_key] : [];
  const paused = status?.dispatch_paused ?? false;

  const togglePause = async () => {
    setToggling(true);
    await actions.setDispatchPaused(!paused);
    setToggling(false);
  };

  return (
    <header className={styles.bar}>
      <h1 className={styles.brand}>claude-bridge</h1>

      <div className={styles.projectField}>
        <label htmlFor={projectId} className={styles.projectLabel}>
          Project
        </label>
        <select
          id={projectId}
          className={cx(ui.select, styles.projectSelect)}
          value={status?.project_key ?? ""}
          disabled={!connected || projects.length === 0}
          onChange={(e) => void actions.selectProject(e.target.value)}
        >
          {!status?.project_key && <option value="">—</option>}
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <ul className={styles.chips} aria-label="Trạng thái hệ thống">
        <StatusChip label="Backend" value={backend.text} tone={backend.tone} />
        <StatusChip
          label="Orchestrator"
          value={status ? ORCHESTRATOR_LABEL[status.orchestrator] : "—"}
          tone={status ? ORCH_TONE[status.orchestrator] : "off"}
        />
        {status && <SeatChip status={status} now={now} />}
        <StatusChip label="Đang chạy" value={status ? `${status.running} / ${status.max_concurrency}` : "—"} />
        {paused && <StatusChip label="Giao việc" value="đã dừng" tone="warn" />}
      </ul>

      <div className={styles.actions}>
        {notif === "default" && (
          <button
            type="button"
            className={cx(ui.btn, ui.ghost, ui.small)}
            onClick={async () => setNotif(await requestNotificationPermission())}
            title="Nhận thông báo khi có bản nháp chờ duyệt hoặc task lỗi"
          >
            <Icon name="bell" />
            Bật thông báo
          </button>
        )}
        {!demo && (
          <button type="button" className={cx(ui.btn, ui.ghost, ui.iconBtn)} aria-label="Cài đặt kết nối" title="Cài đặt kết nối" onClick={onOpenConnection}>
            <Icon name="plug" size={16} />
          </button>
        )}
        <button
          type="button"
          className={cx(ui.btn, paused ? ui.primary : ui.warnOutline)}
          disabled={!connected || !status || toggling}
          onClick={() => void togglePause()}
        >
          <Icon name={paused ? "play" : "pause"} size={16} />
          {paused ? "Tiếp tục giao việc" : "Dừng giao việc"}
        </button>
      </div>
    </header>
  );
}
