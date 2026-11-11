// SQLite (better-sqlite3, WAL) + migration theo `PRAGMA user_version` (system design mục 11).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

const TERMINAL = "('completed','failed','cancelled')";
const ACTIVE = "('assigned','running')";

/** Mỗi phần tử là một migration; index + 1 = user_version sau khi chạy. Chỉ thêm, không sửa. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE workers (
    worker_id         TEXT PRIMARY KEY,
    repo              TEXT NOT NULL,
    worktree_path     TEXT NOT NULL,
    host              TEXT NOT NULL,
    state             TEXT NOT NULL CHECK (state IN ('offline','idle','busy')),
    current_task_id   TEXT,
    last_heartbeat    TEXT,
    runner_token_hash TEXT,
    registered_at     TEXT NOT NULL
  );

  CREATE TABLE tasks (
    task_id       TEXT PRIMARY KEY,
    ticket_key    TEXT NOT NULL,
    worker_id     TEXT NOT NULL REFERENCES workers(worker_id),
    state         TEXT NOT NULL CHECK (state IN ('assigned','running','completed','failed','cancelled')),
    attempt       INTEGER NOT NULL CHECK (attempt >= 1),
    session_id    TEXT,
    phase         TEXT,
    branch        TEXT,
    mr_url        TEXT,
    summary       TEXT,
    fail_category TEXT,
    fail_reason   TEXT,
    notes         TEXT,
    usage         TEXT,
    token_hash    TEXT,
    pid           INTEGER,
    assigned_at   TEXT NOT NULL,
    started_at    TEXT,
    ended_at      TEXT
  );
  -- Bất biến 1 và 2 (mục 7.3): backstop ở tầng DB cho kiểm tra trong transaction.
  CREATE UNIQUE INDEX tasks_active_ticket ON tasks(ticket_key) WHERE state IN ${ACTIVE};
  CREATE UNIQUE INDEX tasks_active_worker ON tasks(worker_id) WHERE state IN ${ACTIVE};
  CREATE INDEX tasks_ticket ON tasks(ticket_key);
  CREATE INDEX tasks_state ON tasks(state);
  CREATE UNIQUE INDEX tasks_token_hash ON tasks(token_hash) WHERE token_hash IS NOT NULL;

  -- Bất biến 5: state kết thúc và kết quả công việc không đổi được.
  -- session_id / usage / pid vẫn được điền muộn (event init, exited đến sau complete_task).
  CREATE TRIGGER tasks_terminal_immutable BEFORE UPDATE ON tasks
  WHEN OLD.state IN ${TERMINAL} AND (
    NEW.state IS NOT OLD.state OR NEW.fail_category IS NOT OLD.fail_category OR
    NEW.fail_reason IS NOT OLD.fail_reason OR NEW.mr_url IS NOT OLD.mr_url OR
    NEW.branch IS NOT OLD.branch OR NEW.summary IS NOT OLD.summary OR
    NEW.ended_at IS NOT OLD.ended_at OR NEW.attempt IS NOT OLD.attempt OR
    NEW.ticket_key IS NOT OLD.ticket_key OR NEW.worker_id IS NOT OLD.worker_id OR
    NEW.phase IS NOT OLD.phase
  )
  BEGIN
    SELECT RAISE(ABORT, 'terminal task is immutable');
  END;

  CREATE TABLE events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    type       TEXT NOT NULL,
    worker_id  TEXT,
    task_id    TEXT,
    ticket_key TEXT,
    payload    TEXT NOT NULL
  );

  CREATE TABLE session_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    task_id    TEXT,
    ts         TEXT NOT NULL,
    origin     TEXT NOT NULL CHECK (origin IN ('user','agent','system')),
    event      TEXT NOT NULL
  );
  CREATE INDEX session_events_session ON session_events(session_id, id);
  CREATE INDEX session_events_task ON session_events(task_id, id) WHERE task_id IS NOT NULL;

  -- Dùng bởi Session Manager (phase sau). busy là trạng thái runtime, không lưu.
  CREATE TABLE sessions (
    session_id        TEXT PRIMARY KEY,
    claude_session_id TEXT,
    role              TEXT NOT NULL CHECK (role IN ('planner','orchestrator')),
    project_key       TEXT,
    repo              TEXT,
    title             TEXT,
    state             TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    last_active_at    TEXT NOT NULL
  );

  -- Dùng bởi Permission Broker (phase sau).
  CREATE TABLE permission_requests (
    request_id    TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    tool          TEXT NOT NULL,
    input         TEXT NOT NULL,
    decision      TEXT CHECK (decision IN ('allow','deny')),
    updated_input TEXT,
    reason        TEXT,
    created_at    TEXT NOT NULL,
    decided_at    TEXT
  );
  CREATE INDEX permission_requests_pending ON permission_requests(session_id) WHERE decision IS NULL;

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Mở DB, bật WAL + foreign keys, chạy migration còn thiếu. `path` có thể là ":memory:". */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema version ${current} is newer than this backend supports (${MIGRATIONS.length})`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v] as string;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
