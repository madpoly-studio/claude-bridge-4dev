// Mô hình cảnh: AppState (+ hiệu ứng tạm) → thứ cần vẽ. Thuần, không React, không DOM.
import { TASK_PHASES, isTerminalTaskState } from "@claude-bridge/protocol";
import type { OrchestratorHealth, PermissionRequest, Session, Task, TaskPhase, Worker } from "@claude-bridge/protocol";
import { ORCHESTRATOR_LABEL, WORKER_STATE_LABEL } from "../../../state/event-format";
import { sortedWorkers } from "../../../state/selectors";
import { assignDesks, assignSlots, deskIndexOf } from "./assign";
import type { BubbleTone, SceneFxState, WorkerFx } from "./effects";
import type { AgentSpot, Facing, ZoneId } from "./geometry";
import type { OfficeLayout, Slot } from "./layout";
import { skinOf } from "./skin";
import type { SkinIndex } from "./skin";
import type { AgentAnim, WorkerAnim } from "./sprites";

export type { BubbleTone } from "./effects";
export type DeskScreen = TaskPhase | "waiting" | "off";

export const SCENE_LABEL = {
  waitingRunner: "CHỜ RUNNER",
  done: "XONG",
  failed: "LỖI",
  coffeeBreak: "nghỉ cà phê",
} as const;

/** Phẳng, toàn giá trị nguyên thủy, để memo so sánh nông. */
export interface SceneWorker {
  id: string;
  skin: SkinIndex;
  zone: ZoneId;
  slotId: string;
  x: number;
  y: number;
  gateX: number;
  gateY: number;
  facing: Facing;
  /** Vị trí thẻ tên so với (x, y) khi đứng yên. */
  tagX: number;
  tagY: number;
  /** Animation khi đứng yên; `move` do component tự bật trong lúc trượt. */
  anim: WorkerAnim;
  /** Đổi giá trị thì sprite phát lại từ frame 0 (id của hiệu ứng, 0 nếu không có). */
  animKey: number;
  /** "BUSY" | "IDLE" | "OFFLINE" | "CHỜ RUNNER" | "XONG" | "LỖI". */
  stateLabel: string;
  /** Dòng phụ: ticket key, fail_category, "nghỉ cà phê"; null nếu không có. */
  detail: string | null;
  /** -1: có task nhưng chưa báo phase; 0..4; null: không có task. */
  phaseIndex: number | null;
  taskId: string | null;
  bubbleId: number;
  bubbleText: string | null;
  bubbleTone: BubbleTone;
  ariaLabel: string;
}

export interface WorkersScene {
  actors: SceneWorker[];
  /** deskSlotId → nội dung màn hình. */
  screens: Record<string, DeskScreen>;
  overflow: Record<ZoneId, string[]>;
  /** worker_id → id bàn đang ngồi; truyền lại làm `prevDesks` ở lượt sau để worker không đổi bàn khi còn bận. */
  desks: ReadonlyMap<string, string>;
}

export interface WorkerIntent {
  zone: ZoneId;
  anim: WorkerAnim;
  animKey: number;
  stateLabel: string;
  detail: string | null;
  phaseIndex: number | null;
  taskId: string | null;
  screen: DeskScreen;
}

/** Task đang sống của worker: current_task_id nếu chưa terminal, không thì task chưa terminal mới nhất theo worker_id. */
export function resolveTask(worker: Worker, tasks: Record<string, Task>): Task | null {
  const current = worker.current_task_id ? tasks[worker.current_task_id] : undefined;
  if (current && !isTerminalTaskState(current.state)) return current;
  let best: Task | null = null;
  for (const t of Object.values(tasks)) {
    if (t.worker_id !== worker.worker_id || isTerminalTaskState(t.state)) continue;
    if (!best || t.assigned_at > best.assigned_at) best = t;
  }
  return best;
}

const phaseIndexOf = (task: Task): number => (task.phase ? TASK_PHASES.indexOf(task.phase) : -1);

/** Một worker → ý định cảnh, chưa có vị trí. Dòng trên thắng dòng dưới (bảng E2 của tài liệu kiến trúc). */
export function deriveWorkerScene(worker: Worker, task: Task | null, fx: WorkerFx | undefined, ctx: { rateLimited: boolean }): WorkerIntent {
  const pose = fx?.pose ?? null;
  if (pose?.kind === "happy") {
    return {
      zone: "desk",
      anim: "happy",
      animKey: pose.id,
      stateLabel: SCENE_LABEL.done,
      detail: pose.detail,
      phaseIndex: TASK_PHASES.length - 1,
      taskId: pose.taskId,
      screen: "mr_created",
    };
  }
  if (pose?.kind === "error") {
    return { zone: "desk", anim: "error", animKey: pose.id, stateLabel: SCENE_LABEL.failed, detail: pose.detail, phaseIndex: null, taskId: pose.taskId, screen: "off" };
  }
  if (worker.state === "offline") {
    return { zone: "pod", anim: "sleep", animKey: 0, stateLabel: WORKER_STATE_LABEL.offline, detail: null, phaseIndex: null, taskId: null, screen: "off" };
  }
  if (task?.state === "running") {
    return {
      zone: "desk",
      anim: "work",
      animKey: 0,
      stateLabel: WORKER_STATE_LABEL.busy,
      detail: task.ticket_key,
      phaseIndex: phaseIndexOf(task),
      taskId: task.task_id,
      screen: task.phase ?? "waiting",
    };
  }
  if (task?.state === "assigned") {
    return {
      zone: "desk",
      anim: "idle",
      animKey: 0,
      stateLabel: SCENE_LABEL.waitingRunner,
      detail: task.ticket_key,
      phaseIndex: -1,
      taskId: task.task_id,
      screen: "waiting",
    };
  }
  if (worker.state === "busy") {
    return { zone: "desk", anim: "work", animKey: 0, stateLabel: WORKER_STATE_LABEL.busy, detail: null, phaseIndex: null, taskId: null, screen: "waiting" };
  }
  return {
    zone: "relax",
    anim: "idle",
    animKey: 0,
    stateLabel: WORKER_STATE_LABEL.idle,
    detail: ctx.rateLimited ? SCENE_LABEL.coffeeBreak : null,
    phaseIndex: null,
    taskId: null,
    screen: "off",
  };
}

function ariaLabelOf(id: string, intent: WorkerIntent): string {
  const parts = [id, intent.stateLabel];
  if (intent.detail) parts.push(intent.detail);
  if (intent.phaseIndex !== null) {
    parts.push(intent.phaseIndex >= 0 ? `phase ${intent.phaseIndex + 1}/${TASK_PHASES.length}: ${TASK_PHASES[intent.phaseIndex]}` : "chưa báo phase");
  }
  return `${parts.join(", ")}. ${intent.taskId ? "Mở chi tiết task" : "Xem thông tin worker"}`;
}

/** Gộp: sortedWorkers → intent → gán slot → SceneWorker. */
export function buildWorkersScene(
  input: {
    workers: Record<string, Worker>;
    tasks: Record<string, Task>;
    fx: SceneFxState;
    rateLimited: boolean;
    /** Bàn của lượt trước (WorkersScene.desks); bỏ trống thì gán từ đầu. */
    prevDesks?: ReadonlyMap<string, string>;
  },
  layout: OfficeLayout,
): WorkersScene {
  const sorted = sortedWorkers(input.workers);
  const indexOf = deskIndexOf(sorted.map((w) => w.worker_id));
  const intents = new Map<string, WorkerIntent>();
  const byZone: Record<ZoneId, Array<{ workerId: string; index: number }>> = { desk: [], relax: [], pod: [] };

  for (const w of sorted) {
    const intent = deriveWorkerScene(w, resolveTask(w, input.tasks), input.fx.byWorker[w.worker_id], { rateLimited: input.rateLimited });
    intents.set(w.worker_id, intent);
    byZone[intent.zone].push({ workerId: w.worker_id, index: indexOf.get(w.worker_id) ?? 0 });
  }

  const placed = new Map<string, Slot>();
  const overflow: Record<ZoneId, string[]> = { desk: [], relax: [], pod: [] };

  const slotMap = new Map<string, Slot>([...layout.desks, ...layout.relax, ...layout.pods].map((s) => [s.id, s]));
  // Worker giữ bàn đang ngồi; chưa có bàn thì lấy bàn theo chỉ số nếu trống, không thì bàn trống đầu tiên.
  // Chỉ khi mọi bàn đều có người mới vào chip "+N".
  const desk = assignDesks(
    byZone.desk,
    layout.desks.map((s) => s.id),
    input.prevDesks,
  );
  const rug = layout.relax.filter((s) => s.spot === "rug").map((s) => s.id);
  const plaza = layout.relax.filter((s) => s.spot === "plaza").map((s) => s.id);
  const relax = input.rateLimited ? assignSlots(byZone.relax, [...plaza, ...rug], "compact") : assignSlots(byZone.relax, [...rug, ...plaza], "stable");
  const pod = assignSlots(
    byZone.pod,
    layout.pods.map((s) => s.id),
    "stable",
  );
  for (const [zone, result] of [["desk", desk], ["relax", relax], ["pod", pod]] as const) {
    for (const [workerId, slotId] of result.placed) placed.set(workerId, slotMap.get(slotId)!);
    overflow[zone] = result.overflow;
  }

  const screens: Record<string, DeskScreen> = {};
  for (const d of layout.desks) screens[d.id] = "off";

  const actors: SceneWorker[] = [];
  for (const w of sorted) {
    const slot = placed.get(w.worker_id);
    const intent = intents.get(w.worker_id)!;
    if (!slot) continue;
    if (slot.zone === "desk") screens[slot.id] = intent.screen;
    const bubble = input.fx.byWorker[w.worker_id]?.bubble ?? null;
    actors.push({
      id: w.worker_id,
      skin: skinOf(w.worker_id),
      zone: slot.zone,
      slotId: slot.id,
      x: slot.anchor.x,
      y: slot.anchor.y,
      gateX: slot.gate.x,
      gateY: slot.gate.y,
      facing: slot.facing,
      tagX: slot.tag.x,
      tagY: slot.tag.y,
      anim: intent.anim,
      animKey: intent.animKey,
      stateLabel: intent.stateLabel,
      detail: intent.detail,
      phaseIndex: intent.phaseIndex,
      taskId: intent.taskId,
      bubbleId: bubble?.id ?? 0,
      bubbleText: bubble?.text ?? null,
      bubbleTone: bubble?.tone ?? "progress",
      ariaLabel: ariaLabelOf(w.worker_id, intent),
    });
  }
  return { actors, screens, overflow, desks: desk.placed };
}

export function sceneWorkerEqual(a: SceneWorker, b: SceneWorker): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as Array<keyof SceneWorker>;
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

// ------------------------------------------------------------------ agent

export interface SceneAgent {
  role: "planner" | "orchestrator";
  anim: AgentAnim;
  /** Chỗ agent nên đứng: work khi đang xử lý việc được giao (kể cả đang chờ duyệt), còn lại về góc home. */
  spot: AgentSpot;
  /** "rảnh" | "đang trả lời" | "chờ duyệt (2)" | nhãn ORCHESTRATOR_LABEL... */
  statusLabel: string;
  pendingCount: number;
  /** Planner: phiên cần chuyển tới khi bấm lúc đang alert; null nếu không cần. */
  jumpSessionId: string | null;
  ariaLabel: string;
}

export const AGENT_LABEL = {
  idle: "rảnh",
  plannerBusy: "đang trả lời",
  orchestratorBusy: "đang xử lý",
  noSession: "chưa có phiên",
} as const;

/** Bận theo phiên đang chọn; alert khi có permission ở bất kỳ phiên không phải orchestrator. Cả hai đều là đang làm việc: đứng ở chỗ work. */
export function derivePlannerScene(
  sessions: Record<string, Session>,
  plannerSessionId: string | null,
  permissions: Record<string, PermissionRequest>,
): SceneAgent {
  const pending = Object.values(permissions)
    .filter((p) => sessions[p.session_id]?.role !== "orchestrator")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const current = plannerSessionId ? (sessions[plannerSessionId] ?? null) : null;
  const pendingHere = pending.some((p) => p.session_id === plannerSessionId);
  const jumpSessionId = pending.length > 0 && !pendingHere ? pending[0]!.session_id : null;

  let anim: AgentAnim = "idle";
  let statusLabel: string = current ? AGENT_LABEL.idle : AGENT_LABEL.noSession;
  if (pending.length > 0) {
    anim = "alert";
    statusLabel = `chờ duyệt (${pending.length})`;
  } else if (current?.busy) {
    anim = "processing";
    statusLabel = AGENT_LABEL.plannerBusy;
  }
  const pendingText = pending.length > 0 ? `, ${pending.length} bản nháp chờ duyệt` : "";
  return {
    role: "planner",
    anim,
    spot: anim === "idle" ? "home" : "work",
    statusLabel,
    pendingCount: pending.length,
    jumpSessionId,
    ariaLabel: `Planner, ${pending.length > 0 ? "cần bạn duyệt" : statusLabel}${pendingText}. Mở chat Planner`,
  };
}

/**
 * Chỉ lên chỗ work khi process còn sống và phiên đang bận. dead / stopped / restarting là sự cố của chính process,
 * không phải việc đang làm: đứng ở góc home với trạng thái tương ứng (alert / off / processing).
 */
export function deriveOrchestratorScene(session: Session | null, health: OrchestratorHealth | null): SceneAgent {
  let anim: AgentAnim = "idle";
  let spot: AgentSpot = "home";
  let statusLabel: string = AGENT_LABEL.idle;
  if (health === "dead") {
    anim = "alert";
    statusLabel = `${ORCHESTRATOR_LABEL.dead} · không chạy`;
  } else if (health === "stopped") {
    anim = "off";
    statusLabel = `${ORCHESTRATOR_LABEL.stopped} · đã dừng`;
  } else if (health === "restarting") {
    anim = "processing";
    statusLabel = `${ORCHESTRATOR_LABEL.restarting} · đang khởi động lại`;
  } else if (session?.busy) {
    anim = "processing";
    spot = "work";
    statusLabel = AGENT_LABEL.orchestratorBusy;
  } else if (!session) {
    statusLabel = AGENT_LABEL.noSession;
  }
  return {
    role: "orchestrator",
    anim,
    spot,
    statusLabel,
    pendingCount: 0,
    jumpSessionId: null,
    ariaLabel: `Orchestrator, ${statusLabel}. Mở chat Orchestrator`,
  };
}
