// Các phép suy dẫn thuần từ AppState cho UI.
import type { BusEvent, BusEventType, Session, Task, TaskUsage, Ticket, Worker } from "@claude-bridge/protocol";
import { isTerminalTaskState } from "@claude-bridge/protocol";
import type { AppState, StreamState } from "./types";
import { streamKeyForSession, streamKeyForTask } from "./reducer";

const EMPTY_STREAM: StreamState = { records: [], lastId: 0, loaded: false };

export function sessionStream(state: AppState, sessionId: string | null): StreamState {
  return sessionId ? (state.streams[streamKeyForSession(sessionId)] ?? EMPTY_STREAM) : EMPTY_STREAM;
}

export function taskStream(state: AppState, taskId: string | null): StreamState {
  return taskId ? (state.streams[streamKeyForTask(taskId)] ?? EMPTY_STREAM) : EMPTY_STREAM;
}

const byRecent = (a: Session, b: Session) => (b.last_active_at ?? "").localeCompare(a.last_active_at ?? "");

export function plannerSessions(state: AppState): Session[] {
  return Object.values(state.sessions)
    .filter((s) => s.role === "planner")
    .sort(byRecent);
}

/** Phiên planner mặc định: phiên đã nhớ nếu còn, không thì phiên chưa đóng gần nhất. */
export function pickDefaultPlannerSession(sessions: Session[], preferredId: string | null): string | null {
  if (preferredId && sessions.some((s) => s.session_id === preferredId)) return preferredId;
  const open = [...sessions].sort(byRecent).find((s) => s.state !== "closed");
  return open?.session_id ?? sessions[0]?.session_id ?? null;
}

export function orchestratorSession(state: AppState): Session | null {
  const all = Object.values(state.sessions).filter((s) => s.role === "orchestrator");
  const project = state.status?.project_key ?? null;
  const forProject = project ? all.filter((s) => s.project_key === project) : all;
  const pool = forProject.length > 0 ? forProject : all;
  const live = pool.filter((s) => s.state !== "closed");
  return [...(live.length > 0 ? live : pool)].sort(byRecent)[0] ?? null;
}

/** Task mới nhất của một ticket (attempt lớn nhất, rồi assigned_at muộn nhất). */
export function latestTaskByTicket(tasks: Record<string, Task>): Map<string, Task> {
  const out = new Map<string, Task>();
  for (const t of Object.values(tasks)) {
    const cur = out.get(t.ticket_key);
    if (
      !cur ||
      t.attempt > cur.attempt ||
      (t.attempt === cur.attempt && (t.assigned_at ?? "").localeCompare(cur.assigned_at ?? "") > 0)
    ) {
      out.set(t.ticket_key, t);
    }
  }
  return out;
}

export interface TicketRow {
  key: string;
  summary: string;
  url: string | null;
  labels: string[];
  blockedBy: string[];
  task: Task | null;
}

export interface TicketGroups {
  waiting: TicketRow[];
  inProgress: TicketRow[];
  review: TicketRow[];
  failed: TicketRow[];
}

/** Nhóm ticket cho tab Tickets bằng cách nối ticket Jira với task mới nhất của nó. */
export function groupTickets(tickets: Ticket[], tasks: Record<string, Task>): TicketGroups {
  const latest = latestTaskByTicket(tasks);
  const groups: TicketGroups = { waiting: [], inProgress: [], review: [], failed: [] };
  const seen = new Set<string>();

  const place = (row: TicketRow) => {
    const t = row.task;
    if (t && !isTerminalTaskState(t.state)) groups.inProgress.push(row);
    else if (t?.state === "failed") groups.failed.push(row);
    else if (t?.state === "completed") groups.review.push(row);
    else groups.waiting.push(row);
  };

  for (const ticket of tickets) {
    if (ticket.status_category === "done") continue;
    seen.add(ticket.key);
    place({
      key: ticket.key,
      summary: ticket.summary,
      url: ticket.url || null,
      labels: ticket.labels ?? [],
      blockedBy: ticket.blocked_by ?? [],
      task: latest.get(ticket.key) ?? null,
    });
  }

  // Task đang chạy hoặc lỗi mà ticket chưa có trong danh sách Jira (chưa poll kịp).
  for (const [key, task] of latest) {
    if (seen.has(key)) continue;
    if (isTerminalTaskState(task.state) && task.state !== "failed") continue;
    place({ key, summary: task.summary ?? "", url: null, labels: [], blockedBy: [], task });
  }

  const byKeyAsc = (a: TicketRow, b: TicketRow) => a.key.localeCompare(b.key, undefined, { numeric: true });
  groups.waiting.sort(byKeyAsc);
  groups.inProgress.sort(byKeyAsc);
  groups.review.sort(byKeyAsc);
  groups.failed.sort(byKeyAsc);
  return groups;
}

export function sortedWorkers(workers: Record<string, Worker>): Worker[] {
  return Object.values(workers).sort((a, b) => a.worker_id.localeCompare(b.worker_id, undefined, { numeric: true }));
}

/** Lần kết thúc task gần nhất của worker (để hiện "rảnh N phút"). */
export function lastEndedAt(tasks: Record<string, Task>, workerId: string): string | null {
  let best: string | null = null;
  for (const t of Object.values(tasks)) {
    if (t.worker_id === workerId && t.ended_at && (!best || t.ended_at > best)) best = t.ended_at;
  }
  return best;
}

// ------------------------------------------------------------------ events

export type EventCategory = "all" | "task" | "worker" | "ticket" | "errors";

export interface EventFilter {
  category: EventCategory;
  /** Lọc theo task_id / worker_id / ticket_key (chứa chuỗi, không phân biệt hoa thường). */
  query: string;
}

const ERROR_TYPES: readonly BusEventType[] = ["task.failed", "worker.offline"];

export function isErrorEvent(ev: BusEvent): boolean {
  return ERROR_TYPES.includes(ev.type);
}

export function filterEvents(events: BusEvent[], filter: EventFilter): BusEvent[] {
  const q = filter.query.trim().toLowerCase();
  const out: BusEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (filter.category === "errors" && !isErrorEvent(ev)) continue;
    if (filter.category === "task" && !ev.type.startsWith("task.")) continue;
    if (filter.category === "worker" && !ev.type.startsWith("worker.")) continue;
    if (filter.category === "ticket" && !ev.type.startsWith("ticket.")) continue;
    if (q) {
      const hay = [ev.task_id, ev.worker_id, ev.ticket_key].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(ev);
  }
  return out;
}

// ------------------------------------------------------------------ misc

/** Suy ra base URL Jira từ URL ticket bất kỳ ("https://jira.x/browse/SH-1" -> "https://jira.x"). */
export function jiraBaseUrl(tickets: Ticket[]): string | null {
  for (const t of tickets) {
    const m = /^(.*)\/browse\/[^/]+$/.exec(t.url ?? "");
    if (m?.[1]) return m[1];
  }
  return null;
}

export function ticketUrl(key: string, tickets: Ticket[]): string | null {
  const t = tickets.find((x) => x.key === key);
  if (t?.url) return t.url;
  const base = jiraBaseUrl(tickets);
  return base ? `${base}/browse/${encodeURIComponent(key)}` : null;
}

export function totalTokens(usage: TaskUsage | null | undefined): number | null {
  if (!usage) return null;
  const parts = [usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
  const nums = parts.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null;
}

export function isRateLimited(state: AppState, now: number): boolean {
  const until = state.status?.rate_limited_until;
  if (!until) return false;
  const t = new Date(until).getTime();
  return Number.isNaN(t) ? true : t > now;
}
