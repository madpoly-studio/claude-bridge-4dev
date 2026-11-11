import { describe, expect, it } from "vitest";
import { initialState, insertBusEvent, mergeRecords, reducer, streamKeyForSession, streamKeyForTask } from "../state/reducer";
import type { Action, AppState } from "../state/types";
import { busEvent, makePermission, makeTask, makeWorker, msg, record, snapshot, STATUS } from "./helpers";

const run = (actions: Action[], start: AppState = initialState) => actions.reduce(reducer, start);

describe("reducer: snapshot", () => {
  it("điền entity từ state.snapshot và chỉ giữ permission đang chờ", () => {
    const s = run([
      snapshot({
        workers: [makeWorker({ worker_id: "w-1" })],
        tasks: [makeTask({ task_id: "t-1", ticket_key: "SH-1" })],
        pending_permissions: [makePermission({ request_id: "r-1" }), makePermission({ request_id: "r-2", decision: "allow" })],
        last_seq: 42,
      }),
    ]);
    expect(s.snapshotLoaded).toBe(true);
    expect(s.snapshotSeq).toBe(42);
    expect(Object.keys(s.workers)).toEqual(["w-1"]);
    expect(s.tasks["t-1"]?.ticket_key).toBe("SH-1");
    expect(Object.keys(s.permissions)).toEqual(["r-1"]);
    expect(s.status).toEqual(STATUS);
    // last_seq của snapshot không được nâng lastSeq, nếu không replay sẽ bị bỏ.
    expect(s.lastSeq).toBe(0);
  });

  it("snapshot khi reconnect giữ nguyên log event và luồng session", () => {
    const s1 = run([snapshot(), msg("bus.event", busEvent(1)), msg("session.event", record(1, { type: "user_text", text: "hi" }))]);
    const s2 = reducer(s1, snapshot({ last_seq: 1 }));
    expect(s2.events).toHaveLength(1);
    expect(s2.streams[streamKeyForSession("s-1")]?.records).toHaveLength(1);
  });
});

describe("reducer: bus.event replay", () => {
  it("khử trùng theo seq và giữ thứ tự khi event đến lệch thứ tự", () => {
    const s = run([
      msg("bus.event", busEvent(1)),
      msg("bus.event", busEvent(3)),
      msg("bus.event", busEvent(2)),
      msg("bus.event", busEvent(3)),
      msg("bus.event", busEvent(1)),
    ]);
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.lastSeq).toBe(3);
  });

  it("replay sau reconnect không mất, không trùng event", () => {
    // Kết nối 1: nhận 1..3 rồi rớt mạng.
    let s = run([snapshot({ last_seq: 0 }), ...[1, 2, 3].map((n) => msg("bus.event", busEvent(n))), msg("replay.done", { last_seq: 3 })]);
    expect(s.lastSeq).toBe(3);
    // Kết nối 2: subscribe since_seq=3 nhưng server gửi chồng từ 2 (an toàn: vẫn phải khử trùng).
    s = run([snapshot({ last_seq: 5 }), ...[2, 3, 4, 5].map((n) => msg("bus.event", busEvent(n))), msg("replay.done", { last_seq: 5 })], s);
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(s.lastSeq).toBe(5);
  });

  it("replay.done nâng lastSeq kể cả khi không có event replay", () => {
    const s = run([snapshot({ last_seq: 10 }), msg("replay.done", { last_seq: 10 })]);
    expect(s.lastSeq).toBe(10);
  });

  it("insertBusEvent giới hạn số event, giữ event mới nhất", () => {
    let events = [busEvent(1)];
    for (let i = 2; i <= 6; i++) events = insertBusEvent(events, busEvent(i), 3);
    expect(events.map((e) => e.seq)).toEqual([4, 5, 6]);
  });

  it("task.progress mới hơn snapshot cập nhật phase; event cũ (replay) thì không", () => {
    const base = run([snapshot({ tasks: [makeTask({ task_id: "t-1", ticket_key: "SH-1", phase: "testing" })], last_seq: 10 })]);
    const old = reducer(base, msg("bus.event", busEvent(9, "task.progress", { task_id: "t-1", payload: { phase: "understanding" } })));
    expect(old.tasks["t-1"]?.phase).toBe("testing");
    const fresh = reducer(base, msg("bus.event", busEvent(11, "task.progress", { task_id: "t-1", payload: { phase: "pushing" } })));
    expect(fresh.tasks["t-1"]?.phase).toBe("pushing");
  });

  it("dispatch.paused mới cập nhật status.dispatch_paused", () => {
    const s = run([snapshot({ last_seq: 1 }), msg("bus.event", busEvent(2, "dispatch.paused"))]);
    expect(s.status?.dispatch_paused).toBe(true);
  });
});

describe("reducer: cập nhật entity", () => {
  it("task.updated và worker.updated upsert", () => {
    const s = run([
      snapshot({ tasks: [makeTask({ task_id: "t-1", ticket_key: "SH-1" })], workers: [makeWorker({ worker_id: "w-1" })] }),
      msg("task.updated", makeTask({ task_id: "t-1", ticket_key: "SH-1", state: "completed", mr_url: "u" })),
      msg("task.updated", makeTask({ task_id: "t-2", ticket_key: "SH-2" })),
      msg("worker.updated", makeWorker({ worker_id: "w-1", state: "busy", current_task_id: "t-2" })),
    ]);
    expect(s.tasks["t-1"]?.state).toBe("completed");
    expect(s.tasks["t-2"]).toBeDefined();
    expect(s.workers["w-1"]?.state).toBe("busy");
  });

  it("tickets.updated và system.status thay thế", () => {
    const s = run([
      msg("tickets.updated", { tickets: [{ key: "SH-1" } as never] }),
      msg("system.status", { ...STATUS, orchestrator: "dead" }),
    ]);
    expect(s.tickets).toHaveLength(1);
    expect(s.status?.orchestrator).toBe("dead");
  });
});

describe("reducer: permission", () => {
  it("permission.request thêm, permission.resolved xóa", () => {
    let s = reducer(initialState, msg("permission.request", makePermission({ request_id: "r-1" })));
    expect(s.permissions["r-1"]).toBeDefined();
    s = reducer(s, msg("permission.resolved", makePermission({ request_id: "r-1", decision: "allow" })));
    expect(s.permissions["r-1"]).toBeUndefined();
  });

  it("bỏ qua request đã có quyết định và resolved không tồn tại", () => {
    const s = reducer(initialState, msg("permission.request", makePermission({ request_id: "r-1", decision: "deny" })));
    expect(s.permissions).toEqual({});
    expect(reducer(s, msg("permission.resolved", makePermission({ request_id: "zzz" })))).toBe(s);
  });

  it("local/permission-cleared xóa ngay sau khi respond thành công", () => {
    const s = run([msg("permission.request", makePermission({ request_id: "r-1" })), { type: "local/permission-cleared", requestId: "r-1" }]);
    expect(s.permissions).toEqual({});
  });
});

describe("reducer: luồng session", () => {
  it("session.history + session.event gộp và khử trùng theo id", () => {
    const s = run([
      msg("session.history", { session_id: "s-1", task_id: null, events: [record(1, {}), record(2, {})] }),
      msg("session.event", record(2, {})),
      msg("session.event", record(3, {})),
      msg("session.history", { session_id: "s-1", task_id: null, events: [record(2, {}), record(3, {}), record(4, {})] }),
    ]);
    const stream = s.streams[streamKeyForSession("s-1")]!;
    expect(stream.records.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(stream.lastId).toBe(4);
    expect(stream.loaded).toBe(true);
  });

  it("event có task_id vào luồng của task", () => {
    const s = reducer(initialState, msg("session.event", record(1, {}, { task_id: "t-9" })));
    expect(s.streams[streamKeyForTask("t-9")]?.records).toHaveLength(1);
  });

  it("session.event trùng trả lại đúng state cũ", () => {
    const s1 = reducer(initialState, msg("session.event", record(1, {})));
    expect(reducer(s1, msg("session.event", record(1, {})))).toBe(s1);
  });

  it("mergeRecords chèn record cũ hơn đúng chỗ", () => {
    const stream = mergeRecords({ records: [record(1, {}), record(5, {})], lastId: 5, loaded: true }, [record(3, {})]);
    expect(stream.records.map((r) => r.id)).toEqual([1, 3, 5]);
  });
});

describe("reducer: local", () => {
  it("everLive bật khi vào live và giữ nguyên khi mất kết nối", () => {
    const s = run([
      { type: "local/connection", connection: { phase: "live", error: null, attempt: 0, retryAt: null } },
      { type: "local/connection", connection: { phase: "reconnecting", error: null, attempt: 1, retryAt: 1 } },
    ]);
    expect(s.everLive).toBe(true);
    expect(s.connection.phase).toBe("reconnecting");
  });

  it("local/reset xóa dữ liệu nhưng giữ trạng thái kết nối", () => {
    const s = run([
      { type: "local/connection", connection: { phase: "connecting", error: null, attempt: 0, retryAt: null } },
      msg("bus.event", busEvent(1)),
      { type: "local/reset" },
    ]);
    expect(s.events).toEqual([]);
    expect(s.connection.phase).toBe("connecting");
  });
});
