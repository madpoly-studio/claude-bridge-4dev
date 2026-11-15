import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useBridgeActions } from "../../hooks/bridge-context";
import { orchestratorSession } from "../../state/selectors";
import { StatusBanners } from "../banners/StatusBanners";
import { TaskDetailPanel } from "../task/TaskDetailPanel";
import { TopBar } from "../topbar/TopBar";
import { FloatingChat } from "./chat/FloatingChat";
import { DEBUG_GRID_VALUE, DEBUG_QUERY_PARAM } from "./constants";
import { useDemoDirector } from "./demo/useDemoDirector";
import { useBridgeSelector } from "./hooks/useBridgeSelector";
import { useChatDock } from "./hooks/useChatDock";
import type { ChatTab } from "./hooks/useChatDock";
import { useOfficeFx } from "./hooks/useOfficeFx";
import { useSceneScale } from "./hooks/useSceneScale";
import { deriveOrchestratorScene, derivePlannerScene } from "./model/scene-state";
import { ListDrawer } from "./panels/ListDrawer";
import { WorkerInfoDialog } from "./panels/WorkerInfoDialog";
import { OfficeScene } from "./scene/OfficeScene";
import type { ListKind } from "./scene/OfficeScene";
import styles from "./office.module.css";

interface OfficeViewProps {
  onOpenConnection: () => void;
  /** Nút chuyển chế độ xem, đặt trên top bar. */
  viewSwitch: ReactNode;
}

function isDebugGrid(): boolean {
  return typeof location !== "undefined" && new URLSearchParams(location.search).get(DEBUG_QUERY_PARAM) === DEBUG_GRID_VALUE;
}

/**
 * Chế độ Văn phòng: top bar và banner của dashboard, cảnh isometric, khung chat nổi và các panel.
 * OfficeView đọc từng lát của state (không gọi useBridgeState), nhưng vẫn render lại mỗi khi AppShell render, mà AppShell
 * dùng useBridgeState nên render theo mọi thay đổi, kể cả `streams` lúc chat đang stream. OfficeScene là memo nên các lượt
 * đó không vẽ lại cảnh; vì vậy callback truyền xuống phải qua useCallback và planner / orchestrator qua useMemo.
 * Lưu ý planner / orchestrator là object mới mỗi khi sessions, permissions hoặc status đổi: lúc đó cảnh vẫn vẽ lại.
 */
export default function OfficeView({ onOpenConnection, viewSwitch }: OfficeViewProps) {
  const actions = useBridgeActions();
  const workers = useBridgeSelector((s) => s.workers);
  const tasks = useBridgeSelector((s) => s.tasks);
  const tickets = useBridgeSelector((s) => s.tickets);
  const sessions = useBridgeSelector((s) => s.sessions);
  const permissions = useBridgeSelector((s) => s.permissions);
  const plannerSessionId = useBridgeSelector((s) => s.plannerSessionId);
  const status = useBridgeSelector((s) => s.status);
  const connectionPhase = useBridgeSelector((s) => s.connection.phase);
  const openTaskId = useBridgeSelector((s) => s.openTaskId);
  // orchestratorSession trả về đúng object Session trong state (hoặc null), nên dùng làm selector được.
  const orchestratorOf = useBridgeSelector(orchestratorSession);

  const fx = useOfficeFx();
  const dock = useChatDock();
  useDemoDirector();
  const [list, setList] = useState<ListKind | null>(null);
  const [infoWorkerId, setInfoWorkerId] = useState<string | null>(null);
  const [debug] = useState(isDebugGrid);
  // Vùng cảnh: bản đồ bên trái, khung chat (khi mở) bên phải. Hook ghi hình học của cả hai lên <main>.
  const mainRef = useRef<HTMLElement>(null);
  useSceneScale(mainRef, dock.open);

  const planner = useMemo(() => derivePlannerScene(sessions, plannerSessionId, permissions), [sessions, plannerSessionId, permissions]);
  const orchestrator = useMemo(() => deriveOrchestratorScene(orchestratorOf, status?.orchestrator ?? null), [orchestratorOf, status]);

  const openTask = useCallback((taskId: string) => void actions.openTask(taskId), [actions]);
  const showDock = dock.show;
  const openChat = useCallback(
    (tab: ChatTab, jumpSessionId: string | null, opener: HTMLElement) => {
      if (jumpSessionId) void actions.selectPlannerSession(jumpSessionId);
      showDock(tab, opener);
    },
    [actions, showDock],
  );
  const closeList = useCallback(() => setList(null), []);
  const closeInfo = useCallback(() => setInfoWorkerId(null), []);

  return (
    <div className={styles.app}>
      <TopBar onOpenConnection={onOpenConnection} extraActions={viewSwitch} />
      <StatusBanners />
      <main ref={mainRef} className={styles.main} aria-label="Văn phòng">
        <h2 className="visually-hidden">Văn phòng</h2>
        <OfficeScene
          workers={workers}
          tasks={tasks}
          tickets={tickets}
          status={status}
          connectionPhase={connectionPhase}
          fx={fx}
          planner={planner}
          orchestrator={orchestrator}
          debug={debug}
          onOpenTask={openTask}
          onWorkerInfo={setInfoWorkerId}
          onOpenChat={openChat}
          onOpenList={setList}
        />
        {/* Trong <main> để định vị theo vùng cảnh (dưới top bar và banner); <main> không có transform nên dialog fixed bên trong vẫn phủ cả trang. */}
        <FloatingChat dock={dock} planner={planner} orchestrator={orchestrator} />
      </main>
      {/* Mọi panel nằm ngoài sân khấu (sân khấu có transform nên position: fixed bên trong sẽ bị nhốt). */}
      {openTaskId && <TaskDetailPanel taskId={openTaskId} />}
      {/* Mở task từ danh sách thì danh sách tạm ẩn: không bao giờ có hai bẫy focus cùng lúc. */}
      {list && !openTaskId && <ListDrawer kind={list} onClose={closeList} />}
      {infoWorkerId && !openTaskId && <WorkerInfoDialog workerId={infoWorkerId} onClose={closeInfo} />}
    </div>
  );
}
