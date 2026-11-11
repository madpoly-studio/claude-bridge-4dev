// Store thuần: (state, ServerMessage | LocalAction) -> state. Không side effect.
import { TASK_PHASES } from "@claude-bridge/protocol";
import type { BusEvent, PermissionRequest, Session, SessionEventRecord, TaskPhase } from "@claude-bridge/protocol";
import { MAX_BUS_EVENTS, MAX_STREAM_RECORDS } from "../config";
import { INITIAL_CONNECTION } from "../ws/client";
import type { Action, AppState, StreamState } from "./types";

export const initialState: AppState = {
  connection: INITIAL_CONNECTION,
  everLive: false,
  serverVersion: null,
  projects: [],
  repos: [],
  snapshotLoaded: false,
  snapshotSeq: 0,
  lastSeq: 0,
  workers: {},
  tasks: {},
  tickets: [],
  sessions: {},
  permissions: {},
  status: null,
  events: [],
  streams: {},
  plannerSessionId: null,
  openTaskId: null,
  notices: [],
};

export const streamKeyForSession = (sessionId: string) => `session:${sessionId}`;
export const streamKeyForTask = (taskId: string) => `task:${taskId}`;

export function streamKeyForRecord(r: Pick<SessionEventRecord, "session_id" | "task_id">): string {
  return r.task_id ? streamKeyForTask(r.task_id) : streamKeyForSession(r.session_id);
}

const EMPTY_STREAM: StreamState = { records: [], lastId: 0, loaded: false };

function byKey<T>(items: T[], key: (item: T) => string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of items) out[key(item)] = item;
  return out;
}

/** Chèn event theo seq; trùng seq thì bỏ qua (trả lại đúng mảng cũ). Giữ tối đa `max` event mới nhất. */
export function insertBusEvent(events: BusEvent[], ev: BusEvent, max = MAX_BUS_EVENTS): BusEvent[] {
  const last = events[events.length - 1];
  let next: BusEvent[];
  if (!last || ev.seq > last.seq) {
    next = [...events, ev];
  } else {
    let lo = 0;
    let hi = events.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = events[mid]!.seq;
      if (s === ev.seq) return events;
      if (s < ev.seq) lo = mid + 1;
      else hi = mid - 1;
    }
    next = [...events.slice(0, lo), ev, ...events.slice(lo)];
  }
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Gộp record vào luồng, khử trùng theo id, giữ thứ tự tăng dần. */
export function mergeRecords(stream: StreamState, incoming: SessionEventRecord[], max = MAX_STREAM_RECORDS): StreamState {
  if (incoming.length === 0) return stream;
  const sortedIncoming = [...incoming].sort((a, b) => a.id - b.id);
  const first = sortedIncoming[0]!;
  let records: SessionEventRecord[];
  if (first.id > stream.lastId) {
    records = [...stream.records];
    let prev = stream.lastId;
    for (const r of sortedIncoming) {
      if (r.id > prev) {
        records.push(r);
        prev = r.id;
      }
    }
  } else {
    const map = new Map<number, SessionEventRecord>();
    for (const r of stream.records) map.set(r.id, r);
    for (const r of sortedIncoming) if (!map.has(r.id)) map.set(r.id, r);
    records = [...map.values()].sort((a, b) => a.id - b.id);
  }
  if (records.length > max) records = records.slice(records.length - max);
  const lastRecord = records[records.length - 1];
  return { ...stream, records, lastId: lastRecord ? Math.max(stream.lastId, lastRecord.id) : stream.lastId };
}

function upsertSessions(current: Record<string, Session>, sessions: Session[]): Record<string, Session> {
  if (sessions.length === 0) return current;
  const next = { ...current };
  for (const s of sessions) next[s.session_id] = s;
  return next;
}

function pendingOnly(list: PermissionRequest[]): Record<string, PermissionRequest> {
  return byKey(
    list.filter((p) => p.decision === null),
    (p) => p.request_id,
  );
}

function isTaskPhase(v: unknown): v is TaskPhase {
  return typeof v === "string" && (TASK_PHASES as readonly string[]).includes(v);
}

/** Áp những thay đổi idempotent của bus event mới hơn snapshot (task.updated/system.status vẫn là nguồn chính). */
function applyBusEventToEntities(state: AppState, ev: BusEvent): AppState {
  if (ev.seq <= state.snapshotSeq) return state;
  switch (ev.type) {
    case "task.progress": {
      const task = ev.task_id ? state.tasks[ev.task_id] : undefined;
      const phase = (ev.payload as { phase?: unknown }).phase;
      if (!task || !isTaskPhase(phase) || task.phase === phase) return state;
      return { ...state, tasks: { ...state.tasks, [task.task_id]: { ...task, phase } } };
    }
    case "dispatch.paused":
    case "dispatch.resumed": {
      if (!state.status) return state;
      const paused = ev.type === "dispatch.paused";
      if (state.status.dispatch_paused === paused) return state;
      return { ...state, status: { ...state.status, dispatch_paused: paused } };
    }
    default:
      return state;
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    // ---------------------------------------------------------------- server
    case "auth.ok":
      return {
        ...state,
        serverVersion: action.payload.server_version,
        projects: action.payload.projects ?? [],
        repos: action.payload.repos ?? [],
      };

    case "state.snapshot": {
      const p = action.payload;
      return {
        ...state,
        snapshotLoaded: true,
        snapshotSeq: p.last_seq ?? 0,
        workers: byKey(p.workers ?? [], (w) => w.worker_id),
        tasks: byKey(p.tasks ?? [], (t) => t.task_id),
        tickets: p.tickets ?? [],
        sessions: upsertSessions(state.sessions, p.sessions ?? []),
        permissions: pendingOnly(p.pending_permissions ?? []),
        status: p.status ?? state.status,
      };
    }

    case "bus.event": {
      const ev = action.payload;
      if (typeof ev?.seq !== "number") return state;
      const events = insertBusEvent(state.events, ev);
      if (events === state.events) return state;
      const next = { ...state, events, lastSeq: Math.max(state.lastSeq, ev.seq) };
      return applyBusEventToEntities(next, ev);
    }

    case "replay.done":
      return { ...state, lastSeq: Math.max(state.lastSeq, action.payload.last_seq ?? 0) };

    case "session.history": {
      const { session_id, task_id, events } = action.payload;
      const key = task_id ? streamKeyForTask(task_id) : session_id ? streamKeyForSession(session_id) : null;
      if (!key) return state;
      const stream = mergeRecords(state.streams[key] ?? EMPTY_STREAM, events ?? []);
      return { ...state, streams: { ...state.streams, [key]: { ...stream, loaded: true } } };
    }

    case "session.event": {
      const rec = action.payload;
      if (typeof rec?.id !== "number") return state;
      const key = streamKeyForRecord(rec);
      const prev = state.streams[key] ?? EMPTY_STREAM;
      if (rec.id <= prev.lastId && prev.records.some((r) => r.id === rec.id)) return state;
      return { ...state, streams: { ...state.streams, [key]: mergeRecords(prev, [rec]) } };
    }

    case "session.updated":
      return { ...state, sessions: upsertSessions(state.sessions, [action.payload]) };

    case "worker.updated":
      return { ...state, workers: { ...state.workers, [action.payload.worker_id]: action.payload } };

    case "task.updated":
      return { ...state, tasks: { ...state.tasks, [action.payload.task_id]: action.payload } };

    case "permission.request": {
      const req = action.payload;
      if (req.decision !== null && req.decision !== undefined) return state;
      return { ...state, permissions: { ...state.permissions, [req.request_id]: req } };
    }

    case "permission.resolved": {
      if (!state.permissions[action.payload.request_id]) return state;
      const { [action.payload.request_id]: _removed, ...rest } = state.permissions;
      return { ...state, permissions: rest };
    }

    case "tickets.updated":
      return { ...state, tickets: action.payload.tickets ?? [] };

    case "system.status":
      return { ...state, status: action.payload };

    case "ack":
    case "error":
      return state;

    // ---------------------------------------------------------------- local
    case "local/connection":
      return {
        ...state,
        connection: action.connection,
        everLive: state.everLive || action.connection.phase === "live",
      };

    case "local/sessions":
    case "local/session": {
      const list = action.type === "local/sessions" ? action.sessions : [action.session];
      return { ...state, sessions: upsertSessions(state.sessions, list) };
    }

    case "local/select-planner":
      return { ...state, plannerSessionId: action.sessionId };

    case "local/open-task":
      return { ...state, openTaskId: action.taskId };

    case "local/notice":
      return { ...state, notices: [...state.notices, action.notice] };

    case "local/dismiss-notice":
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };

    case "local/permission-cleared": {
      if (!state.permissions[action.requestId]) return state;
      const { [action.requestId]: _removed, ...rest } = state.permissions;
      return { ...state, permissions: rest };
    }

    case "local/reset":
      return { ...initialState, connection: state.connection };

    default:
      return state;
  }
}
