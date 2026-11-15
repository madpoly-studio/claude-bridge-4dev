// Biến thể tĩnh của demo cho chế độ Văn phòng (`?demo=1&view=office&scenario=...`). Thuần: chỉ trả về action,
// cùng dạng message server gửi. Không sửa demo/fixtures.ts nên test cũ không bị ảnh hưởng.
import type { ServerMessage, ServerMessageType, ServerPayloads, Task, TaskPhase, Worker } from "@claude-bridge/protocol";
import type { Action, AppState } from "../../../state/types";
import { SCENARIO_QUERY_PARAM } from "../constants";

export const SCENARIO_NAMES = [
  "live",
  "still",
  "crowd",
  "paused",
  "ratelimit",
  "dead",
  "disconnected",
  "fx",
  "agents-home",
  "planner-busy",
  "orchestrator-busy",
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export function parseScenario(search: string): ScenarioName {
  const v = new URLSearchParams(search).get(SCENARIO_QUERY_PARAM);
  return (SCENARIO_NAMES as readonly string[]).includes(v ?? "") ? (v as ScenarioName) : "live";
}

let nextMsgId = 0;

export function demoMsg<K extends ServerMessageType>(type: K, payload: ServerPayloads[K]): ServerMessage {
  nextMsgId += 1;
  return { id: `office-demo-${nextMsgId}`, type, payload } as ServerMessage;
}

const MINUTE_MS = 60_000;
const RATE_LIMIT_MINUTES = 5;
const DEMO_REPO = "sniper-hunting-client";

export function demoWorker(id: string, state: Worker["state"], taskId: string | null, now: number): Worker {
  return {
    worker_id: id,
    repo: DEMO_REPO,
    worktree_path: `D:/worktrees/${DEMO_REPO}/${id}`,
    host: "dev-pc",
    state,
    current_task_id: taskId,
    last_heartbeat: new Date(now - (state === "offline" ? 20 * MINUTE_MS : 5_000)).toISOString(),
  };
}

export function demoTask(p: Pick<Task, "task_id" | "ticket_key" | "worker_id" | "state"> & Partial<Task>, now: number): Task {
  return {
    attempt: 1,
    session_id: null,
    phase: null,
    branch: `agent/${p.ticket_key}`,
    mr_url: null,
    summary: null,
    fail_category: null,
    fail_reason: null,
    notes: null,
    usage: null,
    assigned_at: new Date(now - 4 * MINUTE_MS).toISOString(),
    started_at: p.state === "assigned" ? null : new Date(now - 3 * MINUTE_MS).toISOString(),
    ended_at: null,
    ...p,
  };
}

/** 13 worker thêm cho `crowd` (tổng 18): đủ trạng thái và phase; 12 worker ở khu làm việc cho 10 bàn, nên hai worker cuối không có bàn (chip "+N"). */
const CROWD: Array<{ id: string; state: Worker["state"]; ticket?: string; phase?: TaskPhase | null; taskState?: Task["state"] }> = [
  { id: "w-sh-06", state: "busy", ticket: "SH-140", phase: "understanding" },
  { id: "w-sh-07", state: "busy", ticket: "SH-141", phase: "pushing" },
  { id: "w-sh-08", state: "busy", ticket: "SH-142", phase: "mr_created" },
  { id: "w-sh-09", state: "idle" },
  { id: "w-sh-10", state: "idle" },
  { id: "w-sh-11", state: "busy", ticket: "SH-143", phase: "implementing" },
  { id: "w-sh-12", state: "offline" },
  { id: "w-sh-13", state: "busy", ticket: "SH-144", phase: null, taskState: "assigned" },
  { id: "w-sh-14", state: "idle" },
  { id: "w-sh-15", state: "busy", ticket: "SH-145", phase: "testing" },
  { id: "w-sh-16", state: "busy", ticket: "SH-146", phase: "implementing" },
  { id: "w-sh-17", state: "busy", ticket: "SH-147", phase: "understanding" },
  { id: "w-sh-18", state: "busy", ticket: "SH-148", phase: "pushing" },
];

/** Đóng mọi permission đang chờ, để planner hết alert (fixture gốc có sẵn một bản nháp chờ duyệt). */
function resolvePermissions(state: AppState, now: number): Action[] {
  const decided_at = new Date(now).toISOString();
  return Object.values(state.permissions).map((p) => demoMsg("permission.resolved", { ...p, decision: "deny", reason: "Demo", decided_at }));
}

/** Đặt cờ bận cho phiên planner đang chọn hoặc phiên orchestrator. */
function busySession(state: AppState, role: "planner" | "orchestrator", now: number): Action[] {
  const session =
    role === "planner"
      ? state.plannerSessionId
        ? state.sessions[state.plannerSessionId]
        : undefined
      : Object.values(state.sessions).find((s) => s.role === "orchestrator");
  return session ? [demoMsg("session.updated", { ...session, busy: true, last_active_at: new Date(now).toISOString() })] : [];
}

/** Các action áp một lần để đưa state về biến thể tĩnh. */
export function scenarioActions(name: ScenarioName, state: AppState, now: number): Action[] {
  const status = state.status;
  switch (name) {
    case "crowd": {
      const out: Action[] = [];
      let running = 0;
      for (const c of CROWD) {
        const taskId = c.ticket ? `demo-crowd-${c.id}` : null;
        if (taskId && c.ticket) {
          const taskState = c.taskState ?? "running";
          if (taskState === "running") running += 1;
          out.push(demoMsg("task.updated", demoTask({ task_id: taskId, ticket_key: c.ticket, worker_id: c.id, state: taskState, phase: c.phase ?? null }, now)));
        }
        out.push(demoMsg("worker.updated", demoWorker(c.id, c.state, taskId, now)));
      }
      if (status) {
        const total = status.running + running;
        out.push(demoMsg("system.status", { ...status, running: total, max_concurrency: Math.max(status.max_concurrency, total) }));
      }
      return out;
    }
    case "paused":
      return status ? [demoMsg("system.status", { ...status, dispatch_paused: true })] : [];
    case "ratelimit":
      return [
        ...(status
          ? [demoMsg("system.status", { ...status, rate_limited_until: new Date(now + RATE_LIMIT_MINUTES * MINUTE_MS).toISOString() })]
          : []),
        demoMsg("worker.updated", demoWorker("w-sh-06", "idle", null, now)),
        demoMsg("worker.updated", demoWorker("w-sh-07", "idle", null, now)),
      ];
    case "dead":
      return status ? [demoMsg("system.status", { ...status, orchestrator: "dead" })] : [];
    case "agents-home":
      return resolvePermissions(state, now);
    case "planner-busy":
      return [...resolvePermissions(state, now), ...busySession(state, "planner", now)];
    case "orchestrator-busy":
      return [...resolvePermissions(state, now), ...busySession(state, "orchestrator", now)];
    case "disconnected":
      return [
        {
          type: "local/connection",
          connection: { phase: "reconnecting", error: "Demo: mất kết nối tới backend", attempt: 1, retryAt: now + 8_000 },
        },
      ];
    default:
      return [];
  }
}
