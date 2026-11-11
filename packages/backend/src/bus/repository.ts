// Truy cập SQLite cho worker / task / settings. Không chứa luật nghiệp vụ.
import type { FailCategory, Task, TaskPhase, TaskState, TaskUsage, Worker, WorkerState } from "@claude-bridge/protocol";
import type { Db } from "../db/database.js";

interface WorkerRow {
  worker_id: string;
  repo: string;
  worktree_path: string;
  host: string;
  state: WorkerState;
  current_task_id: string | null;
  last_heartbeat: string | null;
  runner_token_hash: string | null;
  registered_at: string;
}

interface TaskRow {
  task_id: string;
  ticket_key: string;
  worker_id: string;
  state: TaskState;
  attempt: number;
  session_id: string | null;
  phase: TaskPhase | null;
  branch: string | null;
  mr_url: string | null;
  summary: string | null;
  fail_category: FailCategory | null;
  fail_reason: string | null;
  notes: string | null;
  usage: string | null;
  token_hash: string | null;
  pid: number | null;
  assigned_at: string;
  started_at: string | null;
  ended_at: string | null;
}

/** Worker kèm field nội bộ không lộ ra ngoài. */
export interface WorkerRecord extends Worker {
  runner_token_hash: string | null;
}

export type TaskPatch = Partial<
  Pick<
    TaskRow,
    | "state"
    | "session_id"
    | "phase"
    | "branch"
    | "mr_url"
    | "summary"
    | "fail_category"
    | "fail_reason"
    | "token_hash"
    | "pid"
    | "started_at"
    | "ended_at"
  >
> & { usage?: TaskUsage | null };

export type WorkerPatch = Partial<
  Pick<WorkerRow, "repo" | "worktree_path" | "host" | "state" | "current_task_id" | "last_heartbeat" | "runner_token_hash">
>;

export interface NewTask {
  task_id: string;
  ticket_key: string;
  worker_id: string;
  attempt: number;
  notes: string | null;
  token_hash: string;
  assigned_at: string;
}

const ACTIVE_SQL = "('assigned','running')";

export class BusRepository {
  constructor(private readonly db: Db) {}

  // ---- workers -----------------------------------------------------------

  getWorker(workerId: string): WorkerRecord | null {
    const row = this.db.prepare("SELECT * FROM workers WHERE worker_id = ?").get(workerId) as WorkerRow | undefined;
    return row ? toWorkerRecord(row) : null;
  }

  getWorkerByTokenHash(tokenHash: string): WorkerRecord | null {
    const row = this.db.prepare("SELECT * FROM workers WHERE runner_token_hash = ?").get(tokenHash) as WorkerRow | undefined;
    return row ? toWorkerRecord(row) : null;
  }

  listWorkers(filter: { state?: WorkerState; repo?: string } = {}): Worker[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM workers WHERE (@state IS NULL OR state = @state) AND (@repo IS NULL OR repo = @repo) ORDER BY worker_id",
      )
      .all({ state: filter.state ?? null, repo: filter.repo ?? null }) as WorkerRow[];
    return rows.map((r) => toWorker(toWorkerRecord(r)));
  }

  insertWorker(worker: Omit<WorkerRow, "current_task_id"> & { current_task_id?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO workers (worker_id, repo, worktree_path, host, state, current_task_id, last_heartbeat, runner_token_hash, registered_at)
         VALUES (@worker_id, @repo, @worktree_path, @host, @state, @current_task_id, @last_heartbeat, @runner_token_hash, @registered_at)`,
      )
      .run({ current_task_id: null, ...worker });
  }

  updateWorker(workerId: string, patch: WorkerPatch): void {
    const keys = Object.keys(patch) as (keyof WorkerPatch)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE workers SET ${sets} WHERE worker_id = @worker_id`).run({ ...patch, worker_id: workerId });
  }

  // ---- tasks -------------------------------------------------------------

  getTask(taskId: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  getTaskByTokenHash(tokenHash: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE token_hash = ?").get(tokenHash) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  listTasks(filter: { state?: TaskState; ticket_key?: string; worker_id?: string } = {}): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE (@state IS NULL OR state = @state)
           AND (@ticket_key IS NULL OR ticket_key = @ticket_key)
           AND (@worker_id IS NULL OR worker_id = @worker_id)
         ORDER BY assigned_at, rowid`,
      )
      .all({ state: filter.state ?? null, ticket_key: filter.ticket_key ?? null, worker_id: filter.worker_id ?? null }) as TaskRow[];
    return rows.map(toTask);
  }

  /** Mọi task active + `limit` task kết thúc gần nhất, theo thứ tự giao. */
  listRecentTasks(limit: number): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE state IN ${ACTIVE_SQL}
            OR task_id IN (SELECT task_id FROM tasks WHERE state NOT IN ${ACTIVE_SQL} ORDER BY assigned_at DESC, rowid DESC LIMIT ?)
         ORDER BY assigned_at, rowid`,
      )
      .all(limit) as TaskRow[];
    return rows.map(toTask);
  }

  listActiveTasks(): Task[] {
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE state IN ${ACTIVE_SQL} ORDER BY assigned_at, rowid`).all() as TaskRow[];
    return rows.map(toTask);
  }

  getActiveTaskForTicket(ticketKey: string): Task | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE ticket_key = ? AND state IN ${ACTIVE_SQL}`)
      .get(ticketKey) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  getActiveTaskForWorker(workerId: string): Task | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE worker_id = ? AND state IN ${ACTIVE_SQL}`)
      .get(workerId) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  countActiveTasks(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state IN ${ACTIVE_SQL}`).get() as { n: number }).n;
  }

  countTasksForTicket(ticketKey: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE ticket_key = ?").get(ticketKey) as { n: number }).n;
  }

  countTasksByState(): Record<TaskState, number> {
    const out: Record<TaskState, number> = { assigned: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state").all() as { state: TaskState; n: number }[];
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  countWorkersByState(): Record<WorkerState, number> {
    const out: Record<WorkerState, number> = { offline: 0, idle: 0, busy: 0 };
    const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM workers GROUP BY state").all() as { state: WorkerState; n: number }[];
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  insertTask(task: NewTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, ticket_key, worker_id, state, attempt, notes, token_hash, assigned_at)
         VALUES (@task_id, @ticket_key, @worker_id, 'assigned', @attempt, @notes, @token_hash, @assigned_at)`,
      )
      .run(task);
  }

  /**
   * Cập nhật có điều kiện: chỉ áp dụng khi task đang ở một trong `fromStates`.
   * Trả về false nếu state đã đổi (đua), để người gọi báo lỗi thay vì ghi đè.
   */
  updateTask(taskId: string, patch: TaskPatch, fromStates?: readonly TaskState[]): boolean {
    const params: Record<string, unknown> = { ...patch, task_id: taskId };
    if (patch.usage !== undefined) params.usage = patch.usage === null ? null : JSON.stringify(patch.usage);
    const keys = Object.keys(patch);
    if (keys.length === 0) return true;
    const sets = keys.map((k) => `${k} = @${k}`).join(", ");
    let where = "task_id = @task_id";
    if (fromStates) {
      fromStates.forEach((s, i) => {
        params[`from${i}`] = s;
      });
      where += ` AND state IN (${fromStates.map((_, i) => `@from${i}`).join(", ")})`;
    }
    return this.db.prepare(`UPDATE tasks SET ${sets} WHERE ${where}`).run(params).changes === 1;
  }

  // ---- settings ----------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }
}

function toWorkerRecord(row: WorkerRow): WorkerRecord {
  return {
    worker_id: row.worker_id,
    repo: row.repo,
    worktree_path: row.worktree_path,
    host: row.host,
    state: row.state,
    current_task_id: row.current_task_id,
    last_heartbeat: row.last_heartbeat,
    runner_token_hash: row.runner_token_hash,
  };
}

/** Bỏ field nội bộ (hash token) trước khi trả ra ngoài. */
export function toWorker(record: WorkerRecord): Worker {
  const { runner_token_hash: _hidden, ...worker } = record;
  return worker;
}

function toTask(row: TaskRow): Task {
  return {
    task_id: row.task_id,
    ticket_key: row.ticket_key,
    worker_id: row.worker_id,
    state: row.state,
    attempt: row.attempt,
    session_id: row.session_id,
    phase: row.phase,
    branch: row.branch,
    mr_url: row.mr_url,
    summary: row.summary,
    fail_category: row.fail_category,
    fail_reason: row.fail_reason,
    notes: row.notes,
    usage: row.usage === null ? null : (JSON.parse(row.usage) as TaskUsage),
    assigned_at: row.assigned_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}
