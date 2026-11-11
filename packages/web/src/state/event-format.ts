// Mô tả ngắn cho từng bus event (tab Events) và nhãn trạng thái.
import type { BusEvent, OrchestratorHealth, TaskState, WorkerState } from "@claude-bridge/protocol";
import { mrLabel } from "../lib/format";

export type EventTone = "accent" | "warn" | "dim";

type Payload = Record<string, unknown>;

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function describeBusEvent(ev: BusEvent): string {
  const p = (ev.payload ?? {}) as Payload;
  const key = ev.ticket_key ?? ev.task_id ?? "";
  const join = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" · ");
  switch (ev.type) {
    case "worker.registered":
      return join(ev.worker_id, "đăng ký");
    case "worker.offline":
      return join(ev.worker_id, "mất heartbeat");
    case "task.assigned":
      return `${key} → ${ev.worker_id ?? "?"}`;
    case "task.started":
      return join(key, ev.worker_id);
    case "task.progress":
      return join(key, s(p.phase), s(p.message));
    case "task.completed":
      return join(key, s(p.mr_url) ? mrLabel(s(p.mr_url)) : null);
    case "task.failed":
      return join(key, s(p.category), typeof p.attempt === "number" ? `lần ${p.attempt}` : null, s(p.reason));
    case "task.cancelled":
      return join(key, s(p.reason));
    case "ticket.created":
      return join(ev.ticket_key, "từ planner");
    case "dispatch.paused":
      return "Dừng giao việc";
    case "dispatch.resumed":
      return "Tiếp tục giao việc";
    default:
      return join(key, ev.worker_id);
  }
}

export function busEventTone(ev: BusEvent): EventTone {
  if (ev.type === "task.failed" || ev.type === "worker.offline" || ev.type === "dispatch.paused") return "warn";
  if (ev.type.startsWith("task.")) return "accent";
  return "dim";
}

export const WORKER_STATE_LABEL: Record<WorkerState, string> = {
  busy: "BUSY",
  idle: "IDLE",
  offline: "OFFLINE",
};

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  assigned: "ASSIGNED",
  running: "RUNNING",
  completed: "COMPLETED",
  failed: "FAILED",
  cancelled: "CANCELLED",
};

export const ORCHESTRATOR_LABEL: Record<OrchestratorHealth, string> = {
  alive: "alive",
  restarting: "restarting",
  dead: "dead",
  stopped: "stopped",
};
