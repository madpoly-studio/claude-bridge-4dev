import { useBridgeState } from "../hooks/bridge-context";
import { StatusBanners } from "./banners/StatusBanners";
import { LogColumn } from "./log/LogColumn";
import { OrchestratorColumn } from "./orchestrator/OrchestratorColumn";
import { PlannerColumn } from "./planner/PlannerColumn";
import { TaskDetailPanel } from "./task/TaskDetailPanel";
import { TopBar } from "./topbar/TopBar";
import styles from "./dashboard.module.css";

interface DashboardProps {
  onOpenConnection: () => void;
}

/** Màn hình chính: top bar, banner trạng thái, 3 cột. */
export function Dashboard({ onOpenConnection }: DashboardProps) {
  const { openTaskId } = useBridgeState();
  return (
    <div className={styles.app}>
      <TopBar onOpenConnection={onOpenConnection} />
      <StatusBanners />
      <main className={styles.columns}>
        <PlannerColumn />
        <OrchestratorColumn />
        <LogColumn />
      </main>
      {openTaskId && <TaskDetailPanel taskId={openTaskId} />}
    </div>
  );
}
