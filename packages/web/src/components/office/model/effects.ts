// Hiệu ứng tạm của cảnh (bong bóng, happy, error, giấy note bay). Reducer thuần: `now` luôn được truyền vào.
import { isTerminalTaskState } from "@claude-bridge/protocol";
import type { BusEvent, FailCategory, Task } from "@claude-bridge/protocol";
import { FX_MS } from "../constants";

export type BubbleTone = "progress" | "fail" | "info";

export interface PoseFx {
  id: number;
  kind: "happy" | "error";
  /** happy: ticket key; error: fail_category. */
  detail: string | null;
  /** Task vừa kết thúc, để bấm robot trong lúc hiệu ứng vẫn mở đúng task. */
  taskId: string;
  until: number;
}

export interface BubbleFx {
  id: number;
  text: string;
  tone: BubbleTone;
  until: number;
}

export interface WorkerFx {
  pose: PoseFx | null;
  bubble: BubbleFx | null;
}

export interface NoteFx {
  id: number;
  /** Worker vừa xong task: giấy note bay từ bàn nó đang ngồi (cảnh tự tra vị trí). */
  workerId: string;
  until: number;
}

export interface SceneFxState {
  byWorker: Record<string, WorkerFx>;
  notes: NoteFx[];
  nextId: number;
}

export const INITIAL_FX: SceneFxState = { byWorker: {}, notes: [], nextId: 1 };

export interface TaskTransition {
  workerId: string;
  taskId: string;
  ticketKey: string;
  to: "completed" | "failed" | "cancelled";
  failCategory: FailCategory | null;
}

export const CANCELLED_TEXT = "đã hủy";
const UNKNOWN_FAIL_TEXT = "lỗi";

/** Chỉ tính task CÓ trong prev, chưa terminal ở prev và terminal ở next. Task mới xuất hiện đã terminal thì bỏ. */
export function detectTransitions(prev: Record<string, Task>, next: Record<string, Task>): TaskTransition[] {
  if (prev === next) return [];
  const out: TaskTransition[] = [];
  for (const [id, after] of Object.entries(next)) {
    const before = prev[id];
    if (!before || before === after) continue;
    if (isTerminalTaskState(before.state) || !isTerminalTaskState(after.state)) continue;
    out.push({
      workerId: after.worker_id,
      taskId: id,
      ticketKey: after.ticket_key,
      to: after.state as TaskTransition["to"],
      failCategory: after.fail_category,
    });
  }
  return out;
}

/** Các task.progress có seq > cursor và payload.message là chuỗi khác rỗng; mỗi worker lấy cái mới nhất. */
export function collectProgress(
  events: readonly BusEvent[],
  cursorSeq: number,
): { items: Array<{ workerId: string; text: string }>; cursorSeq: number } {
  const latest = new Map<string, string>();
  let maxSeq = cursorSeq;
  // events tăng dần theo seq: đi ngược từ cuối, dừng khi chạm con trỏ.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.seq <= cursorSeq) break;
    if (ev.seq > maxSeq) maxSeq = ev.seq;
    if (ev.type !== "task.progress" || !ev.worker_id || latest.has(ev.worker_id)) continue;
    const message = (ev.payload as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.trim() !== "") latest.set(ev.worker_id, message.trim());
  }
  return { items: [...latest].map(([workerId, text]) => ({ workerId, text })), cursorSeq: maxSeq };
}

export type FxAction =
  | { type: "transitions"; items: TaskTransition[]; now: number }
  | { type: "progress"; items: Array<{ workerId: string; text: string }>; now: number }
  | { type: "expire"; now: number }
  | { type: "reset" };

const EMPTY_WORKER_FX: WorkerFx = { pose: null, bubble: null };

export function fxReducer(state: SceneFxState, action: FxAction): SceneFxState {
  switch (action.type) {
    case "transitions": {
      if (action.items.length === 0) return state;
      const byWorker = { ...state.byWorker };
      const notes = [...state.notes];
      let nextId = state.nextId;
      for (const t of action.items) {
        const cur = byWorker[t.workerId] ?? EMPTY_WORKER_FX;
        if (t.to === "completed") {
          byWorker[t.workerId] = {
            // Bong bóng progress cũ không còn đúng khi task đã xong.
            bubble: null,
            pose: { id: nextId++, kind: "happy", detail: t.ticketKey, taskId: t.taskId, until: action.now + FX_MS.happy },
          };
          notes.push({ id: nextId++, workerId: t.workerId, until: action.now + FX_MS.note });
        } else if (t.to === "failed") {
          const text = t.failCategory ?? UNKNOWN_FAIL_TEXT;
          byWorker[t.workerId] = {
            pose: { id: nextId++, kind: "error", detail: text, taskId: t.taskId, until: action.now + FX_MS.error },
            bubble: { id: nextId++, text, tone: "fail", until: action.now + FX_MS.error },
          };
        } else {
          byWorker[t.workerId] = {
            pose: cur.pose,
            bubble: { id: nextId++, text: CANCELLED_TEXT, tone: "info", until: action.now + FX_MS.cancelBubble },
          };
        }
      }
      return { byWorker, notes, nextId };
    }

    case "progress": {
      if (action.items.length === 0) return state;
      const byWorker = { ...state.byWorker };
      let nextId = state.nextId;
      for (const p of action.items) {
        const cur = byWorker[p.workerId] ?? EMPTY_WORKER_FX;
        byWorker[p.workerId] = {
          pose: cur.pose,
          bubble: { id: nextId++, text: p.text, tone: "progress", until: action.now + FX_MS.bubble },
        };
      }
      return { ...state, byWorker, nextId };
    }

    case "expire": {
      let changed = false;
      const byWorker: Record<string, WorkerFx> = {};
      for (const [id, fx] of Object.entries(state.byWorker)) {
        const pose = fx.pose && fx.pose.until > action.now ? fx.pose : null;
        const bubble = fx.bubble && fx.bubble.until > action.now ? fx.bubble : null;
        if (pose !== fx.pose || bubble !== fx.bubble) changed = true;
        if (pose || bubble) byWorker[id] = pose === fx.pose && bubble === fx.bubble ? fx : { pose, bubble };
      }
      const notes = state.notes.filter((n) => n.until > action.now);
      if (notes.length !== state.notes.length) changed = true;
      return changed ? { byWorker, notes, nextId: state.nextId } : state;
    }

    case "reset":
      return state.notes.length === 0 && Object.keys(state.byWorker).length === 0 ? state : { ...INITIAL_FX, nextId: state.nextId };

    default:
      return state;
  }
}

/** Hạn gần nhất trong state, null nếu không còn hiệu ứng. */
export function nextExpiry(state: SceneFxState): number | null {
  let best: number | null = null;
  const consider = (t: number) => {
    if (best === null || t < best) best = t;
  };
  for (const fx of Object.values(state.byWorker)) {
    if (fx.pose) consider(fx.pose.until);
    if (fx.bubble) consider(fx.bubble.until);
  }
  for (const n of state.notes) consider(n.until);
  return best;
}
