import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Session } from "@claude-bridge/protocol";
import { ChatStream } from "../components/chat/ChatStream";
import { SessionLog } from "../components/task/SessionLog";
import { LiveBridgeService } from "../services/live-bridge-service";
import { initialState, mergeRecords, reducer, streamKeyForSession, streamKeyForTask } from "../state/reducer";
import { createStore } from "../state/store";
import { createFakeTransport } from "./fake-transport";
import type { FakeConnection } from "./fake-transport";
import { makeTask, msg, record, STATUS } from "./helpers";

const flush = () => vi.advanceTimersByTimeAsync(0);

function session(id: string, role: Session["role"], lastActive: string): Session {
  return { session_id: id, claude_session_id: null, role, project_key: "SH", repo: "sh", title: null, state: "active", busy: false, created_at: "", last_active_at: lastActive };
}

/** Ack mọi request chưa được trả lời (trừ auth), lặp đến khi không còn request mới. */
async function ackAll(conn: FakeConnection, acked: Set<string>): Promise<void> {
  for (let round = 0; round < 10; round++) {
    const todo = conn.sent.filter((m) => m.type !== "auth" && !acked.has(m.id));
    if (todo.length === 0) return;
    for (const m of todo) {
      acked.add(m.id);
      const result = m.type === "session.list" ? [session("p-1", "planner", "2"), session("p-2", "planner", "1")] : {};
      conn.push({ id: m.id, type: "ack", payload: { result } });
    }
    await flush();
  }
}

const sentOfType = (conn: FakeConnection, type: string) => conn.sent.filter((m) => m.type === type);

describe("reducer: luồng bị cắt và bỏ luồng", () => {
  it("session.history có truncated → luồng đánh dấu truncated, giữ qua các lần history sau", () => {
    const key = streamKeyForSession("s-1");
    let s = reducer(initialState, msg("session.history", { session_id: "s-1", task_id: null, events: [record(5, {})], truncated: true } as never));
    expect(s.streams[key]?.truncated).toBe(true);
    s = reducer(s, msg("session.history", { session_id: "s-1", task_id: null, events: [record(6, {})] }));
    expect(s.streams[key]?.truncated).toBe(true);

    const plain = reducer(initialState, msg("session.history", { session_id: "s-1", task_id: null, events: [record(1, {})] }));
    expect(plain.streams[key]?.truncated).toBeUndefined();
  });

  it("vượt giới hạn record → truncated", () => {
    const merged = mergeRecords({ records: [], lastId: 0, loaded: true }, [record(1, {}), record(2, {}), record(3, {})], 2);
    expect(merged.records.map((r) => r.id)).toEqual([2, 3]);
    expect(merged.truncated).toBe(true);
  });

  it("local/drop-streams xóa đúng các khóa", () => {
    let s = reducer(initialState, msg("session.history", { session_id: "a", task_id: null, events: [] }));
    s = reducer(s, msg("session.history", { session_id: "b", task_id: null, events: [] }));
    const next = reducer(s, { type: "local/drop-streams", keys: [streamKeyForSession("a"), "không-có"] });
    expect(Object.keys(next.streams)).toEqual([streamKeyForSession("b")]);
    expect(reducer(next, { type: "local/drop-streams", keys: ["không-có"] })).toBe(next);
  });
});

describe("ChatStream: event của bridge", () => {
  afterEach(cleanup);
  it("lời chào hiện thành card bridge (đoạn + `code`), notice hiện thành dòng cảnh báo", () => {
    const records = [
      record(1, { type: "bridge_welcome", text: "Bridge đã khởi động · project `SH`.\n\nVí dụ yêu cầu:\n- Tình hình các worker?" }, { origin: "system" }),
      record(2, { type: "bridge_notice", message: "Claude process exited" }, { origin: "system" }),
    ];
    render(
      <ChatStream records={records} loaded speaker="orchestrator" options={{ collapseReadOnly: false }} emptyText="trống" ariaLabel="luồng" />,
    );
    const card = screen.getByRole("note", { name: "Thông báo của bridge" });
    expect(card.querySelectorAll("p")).toHaveLength(2);
    expect(card.querySelector("code")?.textContent).toBe("SH");
    expect(card.textContent).toContain("- Tình hình các worker?");
    expect(screen.getByText("Claude process exited")).toBeTruthy();
    expect(screen.queryByText(/bridge_notice/)).toBeNull();
  });
});

describe("SessionLog", () => {
  afterEach(cleanup);
  it("hiện dòng 'Đã ẩn các sự kiện cũ hơn' khi luồng bị cắt", () => {
    render(<SessionLog records={[record(9, { type: "result", subtype: "success" })]} loaded truncated />);
    expect(screen.getByText("Đã ẩn các sự kiện cũ hơn")).toBeTruthy();
  });
});

describe("LiveBridgeService: giải phóng luồng không còn hiển thị", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("đóng task / đổi phiên planner bỏ luồng cũ, bỏ qua event của nó, mở lại thì tải lại lịch sử", async () => {
    const fake = createFakeTransport();
    const store = createStore();
    const service = new LiveBridgeService(store, { transport: fake.factory });
    service.connect("ws://x/ws", "tok");
    const conn = fake.connections[0]!;
    const acked = new Set<string>();
    conn.handlers.onOpen();
    conn.push({ id: conn.lastOfType("auth")!.id, type: "auth.ok", payload: { server_version: "1", projects: ["SH"], repos: [] } });
    const sessions = [session("o-1", "orchestrator", "3"), session("p-1", "planner", "2"), session("p-2", "planner", "1")];
    const tasks = [makeTask({ task_id: "t-1", ticket_key: "SH-1" })];
    conn.push({ id: "n", type: "state.snapshot", payload: { workers: [], tasks, tickets: [], sessions, pending_permissions: [], status: STATUS, last_seq: 0 } });
    conn.push({ id: "n", type: "replay.done", payload: { last_seq: 0 } });
    await ackAll(conn, acked);

    const P1 = streamKeyForSession("p-1");
    const O1 = streamKeyForSession("o-1");
    const T1 = streamKeyForTask("t-1");
    expect(store.getState().plannerSessionId).toBe("p-1");
    conn.push({ id: "n", type: "session.history", payload: { session_id: "p-1", task_id: null, events: [record(1, {}, { session_id: "p-1" })] } });
    conn.push({ id: "n", type: "session.history", payload: { session_id: "o-1", task_id: null, events: [record(1, {}, { session_id: "o-1" })] } });

    // Mở task: nhận lịch sử + event live.
    void service.openTask("t-1");
    await ackAll(conn, acked);
    expect(sentOfType(conn, "task.open").map((m) => m.payload)).toEqual([{ task_id: "t-1" }]);
    conn.push({ id: "n", type: "session.history", payload: { session_id: "w", task_id: "t-1", events: [record(1, {}, { task_id: "t-1" })] } });
    conn.push({ id: "n", type: "session.event", payload: record(2, {}, { task_id: "t-1" }) });
    expect(store.getState().streams[T1]?.records.map((r) => r.id)).toEqual([1, 2]);

    // Đóng panel: bỏ luồng task, giữ planner + orchestrator; event/history tới sau bị bỏ qua.
    void service.openTask(null);
    expect(Object.keys(store.getState().streams).sort()).toEqual([O1, P1].sort());
    conn.push({ id: "n", type: "session.event", payload: record(3, {}, { task_id: "t-1" }) });
    conn.push({ id: "n", type: "session.history", payload: { session_id: "w", task_id: "t-1", events: [record(3, {}, { task_id: "t-1" })] } });
    expect(store.getState().streams[T1]).toBeUndefined();

    // Mở lại: gửi task.open không có since (tải lại lịch sử).
    void service.openTask("t-1");
    await ackAll(conn, acked);
    expect(sentOfType(conn, "task.open").map((m) => m.payload)).toEqual([{ task_id: "t-1" }, { task_id: "t-1" }]);

    // Đổi phiên planner: bỏ p-1, giữ orchestrator và task đang mở.
    void service.selectPlannerSession("p-2");
    await ackAll(conn, acked);
    conn.push({ id: "n", type: "session.history", payload: { session_id: "w", task_id: "t-1", events: [record(1, {}, { task_id: "t-1" })] } });
    expect(store.getState().streams[P1]).toBeUndefined();
    expect(store.getState().streams[O1]).toBeDefined();
    expect(store.getState().streams[T1]).toBeDefined();
    conn.push({ id: "n", type: "session.event", payload: record(2, {}, { session_id: "p-1" }) });
    expect(store.getState().streams[P1]).toBeUndefined();

    // Quay lại p-1: mở lại từ đầu.
    void service.selectPlannerSession("p-1");
    await ackAll(conn, acked);
    const opensP1 = sentOfType(conn, "session.open").filter((m) => m.payload.session_id === "p-1");
    expect(opensP1.map((m) => m.payload)).toEqual([{ session_id: "p-1" }, { session_id: "p-1" }]);
    service.disconnect();
  });
});
