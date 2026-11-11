import type {
  BusEvent,
  BusEventType,
  PermissionRequest,
  ServerMessage,
  ServerMessageType,
  ServerPayloads,
  SessionEventRecord,
  SystemStatus,
  Task,
  Ticket,
  Worker,
} from "@claude-bridge/protocol";

export function msg<K extends ServerMessageType>(type: K, payload: ServerPayloads[K], id = "x"): ServerMessage {
  return { id, type, payload } as ServerMessage;
}

export function busEvent(seq: number, type: BusEventType = "task.progress", extra: Partial<BusEvent> = {}): BusEvent {
  return { seq, ts: `2026-11-11T10:00:${String(seq % 60).padStart(2, "0")}Z`, type, worker_id: null, task_id: null, ticket_key: null, payload: {}, ...extra };
}

export function makeTask(p: Partial<Task> & Pick<Task, "task_id" | "ticket_key">): Task {
  return {
    worker_id: "w-1",
    state: "running",
    attempt: 1,
    session_id: null,
    phase: null,
    branch: null,
    mr_url: null,
    summary: null,
    fail_category: null,
    fail_reason: null,
    notes: null,
    usage: null,
    assigned_at: "2026-11-11T10:00:00Z",
    started_at: null,
    ended_at: null,
    ...p,
  };
}

export function makeWorker(p: Partial<Worker> & Pick<Worker, "worker_id">): Worker {
  return { repo: "repo", worktree_path: "/wt/1", host: "h", state: "idle", current_task_id: null, last_heartbeat: null, ...p };
}

export function makeTicket(p: Partial<Ticket> & Pick<Ticket, "key">): Ticket {
  return {
    summary: `Ticket ${p.key}`,
    issue_type: "Task",
    status: "To Do",
    status_category: "new",
    labels: ["agent"],
    url: `https://jira.test/browse/${p.key}`,
    blocked_by: [],
    updated: null,
    ...p,
  };
}

export function makePermission(p: Partial<PermissionRequest> & Pick<PermissionRequest, "request_id">): PermissionRequest {
  return {
    session_id: "p-1",
    tool: "mcp__jira__create_issue",
    input: { summary: "S" },
    decision: null,
    updated_input: null,
    reason: null,
    created_at: "2026-11-11T10:00:00Z",
    decided_at: null,
    ...p,
  };
}

export const STATUS: SystemStatus = {
  backend: "ok",
  project_key: "SH",
  orchestrator: "alive",
  dispatch_paused: false,
  running: 0,
  max_concurrency: 2,
  jira: "ok",
};

export function record(id: number, event: unknown, extra: Partial<SessionEventRecord> = {}): SessionEventRecord {
  return { id, session_id: "s-1", task_id: null, ts: "2026-11-11T10:00:00Z", origin: "agent", event, ...extra };
}

export function snapshot(p: Partial<ServerPayloads["state.snapshot"]> = {}): ServerMessage {
  return msg("state.snapshot", {
    workers: [],
    tasks: [],
    tickets: [],
    sessions: [],
    pending_permissions: [],
    status: STATUS,
    last_seq: 0,
    ...p,
  });
}
