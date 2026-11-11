// Event Log append-only (system design mục 5.5): bảng `events` (bus) và `session_events` (stream thô).
// Payload KHÔNG được chứa token / secret (mục 12) — người gọi chịu trách nhiệm, các module bus chỉ ghi định danh.
import type { BusEvent, BusEventType, SessionEventOrigin, SessionEventRecord } from "@claude-bridge/protocol";
import type { Db } from "../db/database.js";
import { type Clock, toIso } from "../util/clock.js";
import { ListenerSet, type Unsubscribe } from "../util/listeners.js";

export interface BusEventInput {
  type: BusEventType;
  worker_id?: string | null;
  task_id?: string | null;
  ticket_key?: string | null;
  payload?: object;
}

export interface SessionEventInput {
  session_id: string;
  task_id?: string | null;
  origin: SessionEventOrigin;
  event: unknown;
}

export interface SessionEventQuery {
  session_id?: string;
  task_id?: string;
  /** Chỉ lấy event có id > since. */
  since?: number;
  limit?: number;
}

interface BusEventRow {
  seq: number;
  ts: string;
  type: BusEventType;
  worker_id: string | null;
  task_id: string | null;
  ticket_key: string | null;
  payload: string;
}

interface SessionEventRow {
  id: number;
  session_id: string;
  task_id: string | null;
  ts: string;
  origin: SessionEventOrigin;
  event: string;
}

const DEFAULT_SESSION_HISTORY_LIMIT = 5000;

export class EventLog {
  private readonly busListeners = new ListenerSet<BusEvent>("eventLog.bus");
  private readonly sessionListeners = new ListenerSet<SessionEventRecord>("eventLog.session");

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  onBusEvent(cb: (event: BusEvent) => void): Unsubscribe {
    return this.busListeners.add(cb);
  }

  onSessionEvent(cb: (record: SessionEventRecord) => void): Unsubscribe {
    return this.sessionListeners.add(cb);
  }

  /**
   * Chỉ ghi, không thông báo. Dùng bên trong transaction; gọi `publishBusEvent` sau khi commit
   * để listener không thấy event của một transaction bị rollback.
   */
  insertBusEvent(input: BusEventInput): BusEvent {
    const ts = toIso(this.clock.now());
    const payload = input.payload ?? {};
    const info = this.db
      .prepare(
        "INSERT INTO events (ts, type, worker_id, task_id, ticket_key, payload) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(ts, input.type, input.worker_id ?? null, input.task_id ?? null, input.ticket_key ?? null, JSON.stringify(payload));
    return {
      seq: Number(info.lastInsertRowid),
      ts,
      type: input.type,
      worker_id: input.worker_id ?? null,
      task_id: input.task_id ?? null,
      ticket_key: input.ticket_key ?? null,
      payload: payload as Record<string, unknown>,
    };
  }

  publishBusEvent(event: BusEvent): void {
    this.busListeners.emit(event);
  }

  /** Ghi + thông báo ngay. Chỉ dùng ngoài transaction. */
  appendBusEvent(input: BusEventInput): BusEvent {
    const event = this.insertBusEvent(input);
    this.publishBusEvent(event);
    return event;
  }

  /** Event có seq > sinceSeq, tăng dần. */
  readBusEventsSince(sinceSeq: number, limit?: number): BusEvent[] {
    const rows =
      limit === undefined
        ? (this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq").all(sinceSeq) as BusEventRow[])
        : (this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(sinceSeq, limit) as BusEventRow[]);
    return rows.map(toBusEvent);
  }

  lastSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number };
    return row.seq;
  }

  /** Ghi một event session rồi thông báo (ghi trước khi đẩy ra WS, mục 5.2). */
  appendSessionEvent(input: SessionEventInput): SessionEventRecord {
    const [record] = this.appendSessionEvents([input]);
    return record as SessionEventRecord;
  }

  /** Ghi một lô trong một transaction, thông báo sau khi commit. */
  appendSessionEvents(inputs: readonly SessionEventInput[]): SessionEventRecord[] {
    const ts = toIso(this.clock.now());
    const stmt = this.db.prepare("INSERT INTO session_events (session_id, task_id, ts, origin, event) VALUES (?, ?, ?, ?, ?)");
    const records = this.db.transaction(() =>
      inputs.map((input): SessionEventRecord => {
        const info = stmt.run(input.session_id, input.task_id ?? null, ts, input.origin, JSON.stringify(input.event ?? null));
        return {
          id: Number(info.lastInsertRowid),
          session_id: input.session_id,
          task_id: input.task_id ?? null,
          ts,
          origin: input.origin,
          event: input.event ?? null,
        };
      }),
    )();
    for (const record of records) this.sessionListeners.emit(record);
    return records;
  }

  /** Đọc theo session_id hoặc task_id (ít nhất một), id > since, tăng dần. */
  readSessionEvents(query: SessionEventQuery): SessionEventRecord[] {
    const since = query.since ?? 0;
    const limit = query.limit ?? DEFAULT_SESSION_HISTORY_LIMIT;
    let rows: SessionEventRow[];
    if (query.task_id !== undefined) {
      rows = this.db
        .prepare("SELECT * FROM session_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?")
        .all(query.task_id, since, limit) as SessionEventRow[];
    } else if (query.session_id !== undefined) {
      rows = this.db
        .prepare("SELECT * FROM session_events WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?")
        .all(query.session_id, since, limit) as SessionEventRow[];
    } else {
      throw new Error("readSessionEvents requires session_id or task_id");
    }
    return rows.map(toSessionEventRecord);
  }
}

function toBusEvent(row: BusEventRow): BusEvent {
  return {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    worker_id: row.worker_id,
    task_id: row.task_id,
    ticket_key: row.ticket_key,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

function toSessionEventRecord(row: SessionEventRow): SessionEventRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    task_id: row.task_id,
    ts: row.ts,
    origin: row.origin,
    event: JSON.parse(row.event) as unknown,
  };
}
