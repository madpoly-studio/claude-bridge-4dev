// Bảng `sessions` (mục 11). `busy` là trạng thái runtime, không lưu (Session Manager ghép vào).
import type { SessionRole, SessionState } from "@claude-bridge/protocol";
import type { Db } from "../db/database.js";
import { type Clock, toIso } from "../util/clock.js";

export interface SessionRow {
  session_id: string;
  claude_session_id: string | null;
  role: SessionRole;
  project_key: string | null;
  repo: string | null;
  title: string | null;
  state: SessionState;
  created_at: string;
  last_active_at: string;
}

export interface NewSession {
  session_id: string;
  role: SessionRole;
  project_key: string | null;
  repo: string | null;
  title: string | null;
}

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  insert(input: NewSession): SessionRow {
    const now = toIso(this.clock.now());
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, claude_session_id, role, project_key, repo, title, state, created_at, last_active_at)
         VALUES (?, NULL, ?, ?, ?, ?, 'starting', ?, ?)`,
      )
      .run(input.session_id, input.role, input.project_key, input.repo, input.title, now, now);
    return this.require(input.session_id);
  }

  get(sessionId: string): SessionRow | null {
    return (this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as SessionRow | undefined) ?? null;
  }

  require(sessionId: string): SessionRow {
    const row = this.get(sessionId);
    if (!row) throw new Error(`session ${sessionId} not found`);
    return row;
  }

  list(role: SessionRole, opts: { includeClosed?: boolean; limit?: number } = {}): SessionRow[] {
    const closedFilter = opts.includeClosed ? "" : "AND state != 'closed'";
    return this.db
      .prepare(`SELECT * FROM sessions WHERE role = ? ${closedFilter} ORDER BY last_active_at DESC, created_at DESC LIMIT ?`)
      .all(role, opts.limit ?? -1) as SessionRow[];
  }

  /** Session orchestrator chưa đóng gần nhất của project (một orchestrator / project). */
  findOrchestrator(projectKey: string): SessionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM sessions WHERE role = 'orchestrator' AND project_key = ? AND state != 'closed'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(projectKey) as SessionRow | undefined) ?? null
    );
  }

  setState(sessionId: string, state: SessionState): void {
    this.db.prepare("UPDATE sessions SET state = ? WHERE session_id = ?").run(state, sessionId);
  }

  setClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    this.db.prepare("UPDATE sessions SET claude_session_id = ? WHERE session_id = ?").run(claudeSessionId, sessionId);
  }

  touch(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET last_active_at = ? WHERE session_id = ?").run(toIso(this.clock.now()), sessionId);
  }

  /** Khi backend khởi động: session đang mở (process đã mất) chuyển sang `detached`, chờ resume (mục 5.2). */
  detachOpenSessions(): number {
    return this.db.prepare("UPDATE sessions SET state = 'detached' WHERE state IN ('starting','active')").run().changes;
  }
}
