import { useId, useState } from "react";
import type { FormEvent } from "react";
import { COUNTDOWN_TICK_MS, DEFAULT_WS_URL, DEMO_QUERY_PARAM, STORAGE_KEYS } from "../../config";
import { useBridgeActions, useBridgeState } from "../../hooks/bridge-context";
import type { LnaState } from "../../hooks/useLocalNetworkAccess";
import { useNow } from "../../hooks/useNow";
import { cx } from "../../lib/cx";
import { readStorage } from "../../lib/storage";
import { requestNotificationPermission } from "../../services/notifier";
import ui from "../common/ui.module.css";
import styles from "./connect.module.css";

interface ConnectScreenProps {
  lna: LnaState;
  lnaChecked: boolean;
}

const LNA_TEXT: Record<LnaState, { label: string; text: string; tone?: "warn" | "danger" }> = {
  granted: { label: "Local Network Access: đã cấp", text: "Trang được phép kết nối tới backend trên 127.0.0.1." },
  prompt: {
    label: "Local Network Access: chưa cấp",
    text: "Khi bấm Kết nối, Chrome sẽ hỏi quyền truy cập mạng cục bộ cho trang này. Chọn Cho phép (Allow).",
    tone: "warn",
  },
  denied: {
    label: "Local Network Access: bị chặn",
    text: "Mở biểu tượng cài đặt trang bên trái thanh địa chỉ → Local network access → Allow, rồi tải lại trang.",
    tone: "danger",
  },
  unknown: {
    label: "Local Network Access: không xác định",
    text: "Trình duyệt không báo trạng thái quyền. Nếu kết nối thất bại, kiểm tra quyền mạng cục bộ trong cài đặt trang.",
  },
};

const MS_PER_SECOND = 1_000;

/** Màn hình kết nối: URL WebSocket + pairing token, không tự kết nối khi quyền LNA đang ở trạng thái prompt. */
export function ConnectScreen({ lna, lnaChecked }: ConnectScreenProps) {
  const id = useId();
  const actions = useBridgeActions();
  const { connection } = useBridgeState();
  const [url, setUrl] = useState(() => readStorage(STORAGE_KEYS.wsUrl) ?? DEFAULT_WS_URL);
  const [token, setToken] = useState(() => readStorage(STORAGE_KEYS.token) ?? "");
  const [showToken, setShowToken] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const now = useNow(COUNTDOWN_TICK_MS, connection.phase === "reconnecting");

  const busy = ["connecting", "authenticating", "syncing", "reconnecting"].includes(connection.phase);
  const lnaInfo = LNA_TEXT[lna];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmedUrl = url.trim();
    if (!/^wss?:\/\//i.test(trimmedUrl)) {
      setFormError("URL phải bắt đầu bằng ws:// hoặc wss://");
      return;
    }
    if (!token.trim()) {
      setFormError("Dán pairing token in ở terminal của backend.");
      return;
    }
    setFormError(null);
    // Thao tác người dùng: tiện xin quyền thông báo luôn.
    void requestNotificationPermission();
    actions.connect(trimmedUrl, token.trim());
  };

  let alert: string | null = null;
  if (connection.phase === "auth_failed") alert = `Token không hợp lệ${connection.error ? ` (${connection.error})` : ""}. Dán lại pairing token từ terminal của backend.`;
  else if (connection.phase === "origin_rejected")
    alert = `Backend từ chối origin ${typeof location !== "undefined" ? location.origin : ""}. Thêm origin này vào allowed_origins của backend.`;
  else if (connection.phase === "reconnecting") {
    const secs = connection.retryAt ? Math.max(0, Math.ceil((connection.retryAt - now) / MS_PER_SECOND)) : 0;
    alert = `Không kết nối được tới ${url}. Kiểm tra backend đang chạy${lna !== "granted" ? " và quyền Local Network Access" : ""}. Thử lại sau ${secs}s.`;
  }

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <div>
          <h1 className={styles.brand}>claude-bridge</h1>
          <p className={styles.lead}>Kết nối tới backend chạy trên máy này.</p>
        </div>

        {lnaChecked && (
          <div className={cx(styles.lna, lnaInfo.tone === "warn" && styles.lnaWarn, lnaInfo.tone === "danger" && styles.lnaDanger)}>
            <span className={styles.lnaLabel}>{lnaInfo.label}</span>
            <span>{lnaInfo.text}</span>
          </div>
        )}

        <form className={styles.form} onSubmit={submit} noValidate>
          <div className={ui.field}>
            <label htmlFor={`${id}-url`} className={ui.fieldLabel}>
              WebSocket URL
            </label>
            <input
              id={`${id}-url`}
              className={cx(ui.input, ui.mono)}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
          </div>
          <div className={ui.field}>
            <label htmlFor={`${id}-token`} className={ui.fieldLabel}>
              Pairing token
            </label>
            <div className={styles.tokenRow}>
              <input
                id={`${id}-token`}
                type={showToken ? "text" : "password"}
                className={cx(ui.input, ui.mono)}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="Token in ở terminal khi backend khởi động"
              />
              <button type="button" className={ui.btn} onClick={() => setShowToken((v) => !v)} aria-pressed={showToken}>
                {showToken ? "Ẩn" : "Hiện"}
              </button>
            </div>
          </div>

          {formError && (
            <p className={ui.errorText} role="alert">
              {formError}
            </p>
          )}
          {alert && (
            <p className={styles.alert} role="alert">
              {alert}
            </p>
          )}
          {busy && connection.phase !== "reconnecting" && (
            <p className={styles.status} role="status">
              {connection.phase === "syncing" ? "Đang tải snapshot…" : "Đang kết nối…"}
            </p>
          )}

          <div className={styles.actions}>
            <button type="submit" className={cx(ui.btn, ui.primary)} disabled={busy && connection.phase !== "reconnecting"}>
              Kết nối
            </button>
            {busy && (
              <button type="button" className={cx(ui.btn, ui.ghost)} onClick={() => actions.disconnect()}>
                Hủy
              </button>
            )}
            <span className={styles.spacer} />
            <a href={`?${DEMO_QUERY_PARAM}=1`}>Xem demo</a>
          </div>
        </form>
      </div>
    </main>
  );
}
