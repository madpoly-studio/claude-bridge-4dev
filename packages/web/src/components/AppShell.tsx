import { useEffect, useRef } from "react";
import { STORAGE_KEYS, DEFAULT_WS_URL } from "../config";
import { useBridgeActions, useBridgeState, useIsDemo } from "../hooks/bridge-context";
import { useLocalNetworkAccess } from "../hooks/useLocalNetworkAccess";
import { readStorage } from "../lib/storage";
import type { ConnectionPhase } from "../ws/client";
import { NoticeArea } from "./common/NoticeArea";
import { ConnectScreen } from "./connect/ConnectScreen";
import { Dashboard } from "./Dashboard";

/** Pha mà dashboard vẫn hiển thị sau khi đã từng kết nối thành công (kèm banner). */
const DASHBOARD_PHASES: readonly ConnectionPhase[] = ["connecting", "authenticating", "syncing", "live", "reconnecting"];

/** Chọn giữa màn hình kết nối và dashboard; tự kết nối khi quyền LNA cho phép và đã có token. */
export function AppShell() {
  const demo = useIsDemo();
  const state = useBridgeState();
  const actions = useBridgeActions();
  const { state: lna, checked } = useLocalNetworkAccess(!demo);
  const autoTried = useRef(false);

  useEffect(() => {
    if (demo || !checked || autoTried.current) return;
    autoTried.current = true;
    // Không tự mở kết nối khi quyền đang "prompt" (mục 4.1): chờ người dùng bấm Kết nối.
    if (lna === "prompt" || lna === "denied") return;
    const token = readStorage(STORAGE_KEYS.token);
    if (!token) return;
    actions.connect(readStorage(STORAGE_KEYS.wsUrl) ?? DEFAULT_WS_URL, token);
  }, [demo, checked, lna, actions]);

  const showDashboard = demo || (state.everLive && DASHBOARD_PHASES.includes(state.connection.phase));

  return (
    <>
      {showDashboard ? <Dashboard onOpenConnection={() => actions.disconnect()} /> : <ConnectScreen lna={lna} lnaChecked={checked} />}
      <NoticeArea />
    </>
  );
}
