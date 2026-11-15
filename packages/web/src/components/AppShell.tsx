import { lazy, Suspense, useCallback, useEffect, useRef } from "react";
import { STORAGE_KEYS, DEFAULT_WS_URL } from "../config";
import { useBridgeActions, useBridgeState, useIsDemo } from "../hooks/bridge-context";
import { useLocalNetworkAccess } from "../hooks/useLocalNetworkAccess";
import { readStorage } from "../lib/storage";
import { loadToken } from "../lib/token-storage";
import type { ConnectionPhase } from "../ws/client";
import { NoticeArea } from "./common/NoticeArea";
import { ConnectScreen } from "./connect/ConnectScreen";
import { Dashboard } from "./Dashboard";
import { OfficeBoundary } from "./office/OfficeBoundary";
import { ViewSwitchButton } from "./office/ViewSwitchButton";
import { useViewMode } from "./office/view-mode";

/** Chế độ Văn phòng nạp lười: dashboard không tải code và ảnh của nó. */
const OfficeView = lazy(() => import("./office/OfficeView"));

/** Pha mà dashboard vẫn hiển thị sau khi đã từng kết nối thành công (kèm banner). */
const DASHBOARD_PHASES: readonly ConnectionPhase[] = ["connecting", "authenticating", "syncing", "live", "reconnecting"];

/** Chọn giữa màn hình kết nối và dashboard; tự kết nối khi quyền LNA cho phép và đã có token. */
export function AppShell() {
  const demo = useIsDemo();
  const state = useBridgeState();
  const actions = useBridgeActions();
  const { state: lna, checked } = useLocalNetworkAccess(!demo);
  const autoTried = useRef(false);
  const [viewMode, setViewMode] = useViewMode();

  useEffect(() => {
    if (demo || !checked || autoTried.current) return;
    autoTried.current = true;
    // Không tự mở kết nối khi quyền đang "prompt" (mục 4.1): chờ người dùng bấm Kết nối.
    if (lna === "prompt" || lna === "denied") return;
    const { token } = loadToken();
    if (!token) return;
    actions.connect(readStorage(STORAGE_KEYS.wsUrl) ?? DEFAULT_WS_URL, token);
  }, [demo, checked, lna, actions]);

  const showDashboard = demo || (state.everLive && DASHBOARD_PHASES.includes(state.connection.phase));

  const viewSwitch = <ViewSwitchButton mode={viewMode} onChange={setViewMode} />;
  const openConnection = () => actions.disconnect();
  // Văn phòng hỏng: setViewMode ghi "dashboard" vào storage và gỡ `?view=office`, nên tải lại trang không lặp lại lỗi.
  const leaveOffice = useCallback(() => setViewMode("dashboard"), [setViewMode]);

  return (
    <>
      {!showDashboard ? (
        <ConnectScreen lna={lna} lnaChecked={checked} />
      ) : viewMode === "office" ? (
        <OfficeBoundary onFail={leaveOffice}>
          <Suspense fallback={<p role="status">Đang tải văn phòng…</p>}>
            <OfficeView onOpenConnection={openConnection} viewSwitch={viewSwitch} />
          </Suspense>
        </OfficeBoundary>
      ) : (
        <Dashboard onOpenConnection={openConnection} topBarExtra={viewSwitch} />
      )}
      <NoticeArea />
    </>
  );
}
