import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { SystemStatus, Task, Ticket, Worker } from "@claude-bridge/protocol";
import { cx } from "../../../lib/cx";
import { groupTickets } from "../../../state/selectors";
import type { ConnectionPhase } from "../../../ws/client";
import { BACKGROUND_URL, FURNITURE_URLS, WORKER_SHEET_URLS } from "../assets";
import type { ChatTab } from "../hooks/useChatDock";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { useRateLimited } from "../hooks/useRateLimited";
import type { SceneFxState } from "../model/effects";
import type { Point, ZoneId } from "../model/geometry";
import { OFFICE_LAYOUT } from "../model/layout";
import { buildWorkersScene } from "../model/scene-state";
import type { SceneAgent, SceneWorker } from "../model/scene-state";
import { WORKER_BODY } from "../model/sprites";
import { deriveSignals, kanbanCounts, rackGauge } from "../model/system";
import { AgentRobot } from "./AgentRobot";
import { DebugGrid } from "./DebugGrid";
import { Desk } from "./Desk";
import { FlyingNote } from "./FlyingNote";
import { Furniture } from "./Furniture";
import { KanbanPlaque } from "./KanbanBoard";
import { OverflowChip } from "./OverflowChip";
import { SceneSignals } from "./SceneSignals";
import { RackLabel, ServerRackGauge } from "./ServerRackGauge";
import { WorkerRobot } from "./WorkerRobot";
import styles from "./scene.module.css";

export type ListKind = "tickets" | "workers";

interface OfficeSceneProps {
  workers: Record<string, Worker>;
  tasks: Record<string, Task>;
  tickets: Ticket[];
  status: SystemStatus | null;
  connectionPhase: ConnectionPhase;
  fx: SceneFxState;
  planner: SceneAgent;
  orchestrator: SceneAgent;
  debug?: boolean;
  onOpenTask(taskId: string): void;
  onWorkerInfo(workerId: string): void;
  onOpenChat(tab: ChatTab, jumpSessionId: string | null, opener: HTMLElement): void;
  onOpenList(kind: ListKind): void;
}

const ZONES: ZoneId[] = ["desk", "relax", "pod"];
const layout = OFFICE_LAYOUT;
const STAGE_STYLE: CSSProperties = { backgroundImage: `url(${BACKGROUND_URL})` };
const VACUUM_STYLE: CSSProperties = {
  offsetPath: `path("${layout.vacuumPath.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")} Z")`,
  zIndex: Math.round(Math.max(...layout.vacuumPath.map((p) => p.y)) - 60),
};
/** Giấy note xuất phát ngang tầm tay robot. */
const NOTE_LIFT = WORKER_BODY.h * 0.6;

/** Cảnh văn phòng: 4 lớp (chiều sâu, phủ màu, nhãn, hiệu ứng) trên ảnh nền; scale và lề trái do OfficeView đặt qua biến CSS (useSceneScale). */
export const OfficeScene = memo(function OfficeScene({
  workers,
  tasks,
  tickets,
  status,
  connectionPhase,
  fx,
  planner,
  orchestrator,
  debug = false,
  onOpenTask,
  onWorkerInfo,
  onOpenChat,
  onOpenList,
}: OfficeSceneProps) {
  const [labelLayer, setLabelLayer] = useState<HTMLDivElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const rateLimited = useRateLimited(status);

  // Bàn của lượt trước, để worker còn bận không đổi bàn. Chỉ ghi ref sau khi commit, để lượt render bị bỏ không để lại
  // phép gán chưa hiển thị.
  const deskMemory = useRef<ReadonlyMap<string, string>>(new Map());
  const scene = useMemo(
    () => buildWorkersScene({ workers, tasks, fx, rateLimited, prevDesks: deskMemory.current }, layout),
    [workers, tasks, fx, rateLimited],
  );
  useLayoutEffect(() => {
    deskMemory.current = scene.desks;
  }, [scene]);
  // Giấy note bay từ bàn worker đang ngồi; worker không có bàn (chip "+N") thì không có note.
  const notes = useMemo(() => {
    const out: Array<{ id: number; from: Point }> = [];
    if (reducedMotion) return out;
    for (const note of fx.notes) {
      const actor = scene.actors.find((a) => a.id === note.workerId);
      if (actor?.zone === "desk") out.push({ id: note.id, from: { x: actor.x, y: actor.y - NOTE_LIFT } });
    }
    return out;
  }, [fx.notes, scene.actors, reducedMotion]);
  const notesInFlight = notes.length;
  const counts = useMemo(() => kanbanCounts(groupTickets(tickets, tasks), notesInFlight), [tickets, tasks, notesInFlight]);
  const gauge = useMemo(() => rackGauge(status), [status]);
  const signals = useMemo(() => deriveSignals(status, connectionPhase, rateLimited), [status, connectionPhase, rateLimited]);

  // Tải trước nền và các skin đang có mặt; sân khấu có màu nền trơn trong lúc chờ.
  const skinsKey = useMemo(() => [...new Set(scene.actors.map((a) => a.skin))].sort().join(","), [scene.actors]);
  useEffect(() => {
    if (typeof Image === "undefined") return;
    const urls = [BACKGROUND_URL, ...skinsKey.split(",").filter(Boolean).map((s) => WORKER_SHEET_URLS[Number(s) as SceneWorker["skin"]])];
    for (const url of urls) new Image().src = url;
  }, [skinsKey]);

  const activateWorker = useCallback(
    (actor: SceneWorker) => {
      if (actor.taskId) onOpenTask(actor.taskId);
      else onWorkerInfo(actor.id);
    },
    [onOpenTask, onWorkerInfo],
  );
  const activateAgent = useCallback(
    (agent: SceneAgent, opener: HTMLElement) => onOpenChat(agent.role, agent.jumpSessionId, opener),
    [onOpenChat],
  );
  const openTickets = useCallback(() => onOpenList("tickets"), [onOpenList]);
  const openWorkers = useCallback(() => onOpenList("workers"), [onOpenList]);

  const tintMode = signals.disconnected ? "disconnected" : signals.paused ? "paused" : "none";

  return (
    <div className={styles.viewport}>
      <div className={styles.stageBox}>
        <div className={styles.stage} style={STAGE_STYLE} data-frozen={signals.disconnected} data-testid="office-stage">
          <div className={cx(styles.layer, styles.depth)}>
            {layout.decals.map((d) => (
              <span key={d.id} className={styles.decal} data-axis={d.axis} data-tone={d.tone} style={{ left: d.at.x, top: d.at.y }} aria-hidden="true">
                {d.text}
              </span>
            ))}
            {layout.furniture.map((item) => (
              <Furniture key={item.id} item={item} />
            ))}
            <Furniture item={layout.kanban.item} />
            {layout.serverRacks.map((item) => (
              <ServerRackGauge key={item.id} item={item} gauge={gauge} />
            ))}
            {layout.deskItems.map((item) => (
              <Desk key={item.id} item={item} screen={scene.screens[item.slotId] ?? "off"} />
            ))}
            {!reducedMotion && (
              <span className={styles.vacuum} style={VACUUM_STYLE} aria-hidden="true">
                <img src={FURNITURE_URLS.robot_vacuum} alt="" draggable={false} />
              </span>
            )}
            <AgentRobot agent={planner} placement={layout.planner} labelLayer={labelLayer} reducedMotion={reducedMotion} onActivate={activateAgent} />
            <AgentRobot agent={orchestrator} placement={layout.orchestrator} labelLayer={labelLayer} reducedMotion={reducedMotion} onActivate={activateAgent} />
            {scene.actors.map((actor) => (
              <WorkerRobot key={actor.id} actor={actor} labelLayer={labelLayer} reducedMotion={reducedMotion} onActivate={activateWorker} />
            ))}
          </div>

          <div className={cx(styles.layer, styles.tint)} data-mode={tintMode} />
          <div className={cx(styles.layer, styles.tintDim)} data-on={signals.disconnected} />

          <div className={cx(styles.layer, styles.labels)}>
            <RackLabel gauge={gauge} at={layout.rackLabel} />
            <KanbanPlaque counts={counts} at={layout.kanban.plaque} onOpen={openTickets} />
            {ZONES.map((zone) => (
              <OverflowChip key={zone} zone={zone} count={scene.overflow[zone].length} at={layout.overflowChips[zone]} onOpen={openWorkers} />
            ))}
            {/* Thẻ tên và bong bóng của từng robot được portal vào đây. */}
            <div ref={setLabelLayer} />
          </div>

          <div className={cx(styles.layer, styles.fx)}>
            {notes.map((note) => (
              <FlyingNote key={note.id} from={note.from} to={layout.kanban.noteTarget} />
            ))}
            <SceneSignals signals={signals} at={layout.signals} />
          </div>

          {debug && <DebugGrid layout={layout} />}
        </div>
      </div>
    </div>
  );
});
