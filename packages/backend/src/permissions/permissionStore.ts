// Bảng `permission_requests` (mục 11, P5).
import type { PermissionDecision, PermissionRequest } from "@claude-bridge/protocol";
import type { Db } from "../db/database.js";
import { type Clock, toIso } from "../util/clock.js";

interface PermissionRow {
  request_id: string;
  session_id: string;
  tool: string;
  input: string;
  decision: PermissionDecision | null;
  updated_input: string | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
}

export class PermissionStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  insert(input: { request_id: string; session_id: string; tool: string; input: Record<string, unknown> }): PermissionRequest {
    this.db
      .prepare("INSERT INTO permission_requests (request_id, session_id, tool, input, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.request_id, input.session_id, input.tool, JSON.stringify(input.input), toIso(this.clock.now()));
    return this.require(input.request_id);
  }

  get(requestId: string): PermissionRequest | null {
    const row = this.db.prepare("SELECT * FROM permission_requests WHERE request_id = ?").get(requestId) as PermissionRow | undefined;
    return row ? toRequest(row) : null;
  }

  require(requestId: string): PermissionRequest {
    const req = this.get(requestId);
    if (!req) throw new Error(`permission request ${requestId} not found`);
    return req;
  }

  /** Ghi quyết định nếu request còn chờ; false nếu đã có quyết định. */
  decide(
    requestId: string,
    decision: PermissionDecision,
    updatedInput: Record<string, unknown> | null,
    reason: string | null,
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE permission_requests SET decision = ?, updated_input = ?, reason = ?, decided_at = ?
         WHERE request_id = ? AND decision IS NULL`,
      )
      .run(decision, updatedInput === null ? null : JSON.stringify(updatedInput), reason, toIso(this.clock.now()), requestId);
    return info.changes === 1;
  }

  listPending(sessionId?: string): PermissionRequest[] {
    const rows = (
      sessionId === undefined
        ? this.db.prepare("SELECT * FROM permission_requests WHERE decision IS NULL ORDER BY created_at").all()
        : this.db.prepare("SELECT * FROM permission_requests WHERE decision IS NULL AND session_id = ? ORDER BY created_at").all(sessionId)
    ) as PermissionRow[];
    return rows.map(toRequest);
  }
}

function toRequest(row: PermissionRow): PermissionRequest {
  return {
    request_id: row.request_id,
    session_id: row.session_id,
    tool: row.tool,
    input: JSON.parse(row.input) as Record<string, unknown>,
    decision: row.decision,
    updated_input: row.updated_input === null ? null : (JSON.parse(row.updated_input) as Record<string, unknown>),
    reason: row.reason,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}
