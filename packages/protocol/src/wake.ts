// Turn hệ thống đánh thức orchestrator (system design mục 8).

export const WAKE_TRIGGER_TYPES = [
  "ticket.created",
  "task.completed",
  "task.failed",
  "worker.registered",
  "tick",
] as const;
export type WakeTriggerType = (typeof WAKE_TRIGGER_TYPES)[number];

/**
 * `manual`: orchestrator chỉ làm khi người dùng yêu cầu; bridge chỉ báo kết quả task (task.completed / task.failed).
 * `auto`: đánh thức theo mọi trigger (worker.registered, ticket.created có label agent, tick định kỳ, sau khi khởi động lại).
 */
export const WAKE_MODES = ["manual", "auto"] as const;
export type WakeMode = (typeof WAKE_MODES)[number];

/** Chỉ mang định danh; orchestrator tự đọc Jira để lấy nội dung. */
export interface WakeEvent {
  type: WakeTriggerType;
  ticket_key?: string;
  task_id?: string;
  worker_id?: string;
  category?: string;
}

export const BRIDGE_EVENT_MARKER = "[bridge-event]";

export function formatWakeTurn(events: WakeEvent[]): string {
  return `${BRIDGE_EVENT_MARKER}\n${JSON.stringify({ events })}`;
}

export function parseWakeTurn(text: string): WakeEvent[] | null {
  if (!text.startsWith(BRIDGE_EVENT_MARKER)) return null;
  try {
    const body = JSON.parse(text.slice(BRIDGE_EVENT_MARKER.length).trim()) as { events?: WakeEvent[] };
    return Array.isArray(body.events) ? body.events : null;
  } catch {
    return null;
  }
}
