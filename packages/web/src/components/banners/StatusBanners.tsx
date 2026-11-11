import type { ReactNode } from "react";
import { COUNTDOWN_TICK_MS } from "../../config";
import { useBridgeActions, useBridgeState, useIsDemo } from "../../hooks/bridge-context";
import { useNow } from "../../hooks/useNow";
import { cx } from "../../lib/cx";
import { formatHourMinute } from "../../lib/format";
import { isRateLimited } from "../../state/selectors";
import ui from "../common/ui.module.css";
import styles from "./banners.module.css";

type BannerTone = "warn" | "danger" | "info";

interface BannerSpec {
  key: string;
  tone: BannerTone;
  label: string;
  text: ReactNode;
  action?: ReactNode;
}

const MS_PER_SECOND = 1_000;

/** Banner trạng thái (mục 10.3). Mỗi banner có nhãn chữ, không chỉ dựa vào màu. */
export function StatusBanners() {
  const state = useBridgeState();
  const actions = useBridgeActions();
  const demo = useIsDemo();
  const { connection, status } = state;
  const reconnecting = connection.phase === "reconnecting";
  const now = useNow(reconnecting ? COUNTDOWN_TICK_MS : undefined);
  const banners: BannerSpec[] = [];

  if (demo) {
    banners.push({
      key: "demo",
      tone: "info",
      label: "Chế độ demo",
      text: "Dữ liệu mẫu, không có backend. Thao tác chỉ thay đổi trạng thái cục bộ.",
    });
  }

  if (reconnecting) {
    const secs = connection.retryAt ? Math.max(0, Math.ceil((connection.retryAt - now) / MS_PER_SECOND)) : null;
    banners.push({
      key: "reconnect",
      tone: "danger",
      label: "Mất kết nối backend",
      text: `${connection.error ? `${connection.error}. ` : ""}Thử lại ${secs ? `sau ${secs}s` : "ngay"} (lần ${connection.attempt}). Event sẽ được replay từ seq ${state.lastSeq}.`,
      action: (
        <button type="button" className={cx(ui.btn, ui.small)} onClick={() => actions.retryNow()}>
          Thử ngay
        </button>
      ),
    });
  } else if (connection.phase === "connecting" || connection.phase === "authenticating") {
    banners.push({ key: "connecting", tone: "warn", label: "Đang kết nối lại", text: "Đang mở lại kết nối tới backend…" });
  } else if (connection.phase === "syncing") {
    banners.push({
      key: "replay",
      tone: "info",
      label: "Đang replay",
      text: `Đang đồng bộ snapshot và event sau seq ${state.lastSeq}. Dữ liệu có thể chưa đầy đủ.`,
    });
  }

  if (status?.orchestrator === "dead") {
    banners.push({
      key: "orch-dead",
      tone: "danger",
      label: "Orchestrator đã dừng",
      text: "Session orchestrator gặp lỗi. Backend sẽ thử resume; nếu kéo dài, kiểm tra log backend.",
    });
  } else if (status?.orchestrator === "restarting") {
    banners.push({
      key: "orch-restart",
      tone: "warn",
      label: "Orchestrator đang khởi động lại",
      text: "Turn hệ thống và tin nhắn sẽ được xử lý khi orchestrator sẵn sàng.",
    });
  }

  if (isRateLimited(state, now)) {
    banners.push({
      key: "rate",
      tone: "danger",
      label: "Chạm hạn mức seat",
      text: status?.rate_limited_until
        ? `Các session tạm thời bị giới hạn đến ${formatHourMinute(status.rate_limited_until)}.`
        : "Các session tạm thời bị giới hạn.",
    });
  }

  if (status?.dispatch_paused) {
    banners.push({
      key: "paused",
      tone: "warn",
      label: "Đã dừng giao việc",
      text: "assign_task sẽ bị từ chối. Task đang chạy không bị ảnh hưởng.",
    });
  }

  const pending = Object.keys(state.permissions).length;
  if (pending > 0) {
    banners.push({
      key: "pending",
      tone: "warn",
      label: "Chờ duyệt",
      text: `${pending} bản nháp ticket đang chờ bạn duyệt ở cột Planner.`,
    });
  }

  if (banners.length === 0) return null;

  return (
    <div className={styles.stack} role="status" aria-live="polite">
      {banners.map((b) => (
        <div key={b.key} className={cx(styles.banner, styles[b.tone])}>
          <span className={styles.label}>{b.label}</span>
          <span className={styles.text}>{b.text}</span>
          {b.action}
        </div>
      ))}
    </div>
  );
}
