import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_CLOSE } from "@claude-bridge/protocol";
import type { ServerMessage } from "@claude-bridge/protocol";
import { BridgeClient, backoffDelay } from "../ws/client";
import type { ConnectionState } from "../ws/client";
import { LiveBridgeService } from "../services/live-bridge-service";
import { createStore } from "../state/store";
import { streamKeyForSession } from "../state/reducer";
import { createFakeTransport } from "./fake-transport";
import { busEvent, record, STATUS } from "./helpers";

const BACKOFF = { initialMs: 100, maxMs: 1_000, factor: 2 };
const TIMEOUT = 500;
/** Chạy microtask đang chờ mà không kích hoạt timer timeout. */
const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(since: () => number | undefined = () => undefined) {
  const fake = createFakeTransport();
  const messages: ServerMessage[] = [];
  const states: ConnectionState[] = [];
  const client = new BridgeClient({
    url: "ws://127.0.0.1:8787/ws",
    token: "tok",
    transport: fake.factory,
    requestTimeoutMs: TIMEOUT,
    backoff: BACKOFF,
    getSinceSeq: since,
    onMessage: (m) => messages.push(m),
    onConnection: (s) => states.push(s),
  });
  return { fake, client, messages, states, phase: () => states[states.length - 1]?.phase };
}

function authOk(conn: ReturnType<typeof createFakeTransport>["connections"][number]) {
  conn.handlers.onOpen();
  const auth = conn.lastOfType("auth")!;
  conn.push({ id: auth.id, type: "auth.ok", payload: { server_version: "1", projects: ["SH"], repos: [] } });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("BridgeClient", () => {
  it("auth trước, subscribe sau auth.ok, live sau replay.done", () => {
    const { fake, client, phase } = setup(() => 7);
    client.start();
    const conn = fake.connections[0]!;
    expect(phase()).toBe("connecting");
    conn.handlers.onOpen();
    expect(conn.sent[0]).toMatchObject({ type: "auth", payload: { token: "tok" } });
    expect(phase()).toBe("authenticating");
    authOk(conn);
    expect(phase()).toBe("syncing");
    expect(conn.lastOfType("subscribe")?.payload).toEqual({ since_seq: 7 });
    conn.push({ id: "s", type: "replay.done", payload: { last_seq: 7 } });
    expect(phase()).toBe("live");
  });

  it("request nhận ack/error theo id và hết hạn khi không có phản hồi", async () => {
    const { fake, client } = setup();
    client.start();
    const conn = fake.connections[0]!;
    authOk(conn);

    const ok = client.request("session.list", { role: "planner" });
    conn.push({ id: conn.lastOfType("session.list")!.id, type: "ack", payload: { result: [1, 2] } });
    await expect(ok).resolves.toEqual([1, 2]);

    const bad = client.request("session.open", { session_id: "x" });
    conn.push({ id: conn.lastOfType("session.open")!.id, type: "error", payload: { code: "NOT_FOUND", message: "không có" } });
    await expect(bad).rejects.toMatchObject({ code: "NOT_FOUND" });

    const slow = client.request("dispatch.pause", {});
    vi.advanceTimersByTime(TIMEOUT + 1);
    await expect(slow).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("request khi chưa kết nối bị từ chối ngay", async () => {
    const { client } = setup();
    await expect(client.request("dispatch.pause", {})).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });

  it("tự kết nối lại có backoff, từ chối request đang chờ khi rớt", async () => {
    const { fake, client, phase, states } = setup();
    client.start();
    authOk(fake.connections[0]!);
    const pending = client.request("dispatch.pause", {});
    fake.connections[0]!.drop(1006);
    await expect(pending).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(phase()).toBe("reconnecting");
    expect(states[states.length - 1]?.attempt).toBe(1);

    vi.advanceTimersByTime(BACKOFF.initialMs);
    expect(fake.connections).toHaveLength(2);
    fake.connections[1]!.drop(1006);
    vi.advanceTimersByTime(BACKOFF.initialMs);
    expect(fake.connections).toHaveLength(2); // lần 2 chờ 200ms
    vi.advanceTimersByTime(BACKOFF.initialMs);
    expect(fake.connections).toHaveLength(3);
  });

  it("không thử lại khi token sai hoặc origin bị chặn", () => {
    const a = setup();
    a.client.start();
    a.fake.connections[0]!.handlers.onOpen();
    a.fake.connections[0]!.drop(WS_CLOSE.AUTH_FAILED, "bad token");
    expect(a.phase()).toBe("auth_failed");
    vi.advanceTimersByTime(10_000);
    expect(a.fake.connections).toHaveLength(1);

    const b = setup();
    b.client.start();
    b.fake.connections[0]!.drop(WS_CLOSE.ORIGIN_REJECTED);
    expect(b.phase()).toBe("origin_rejected");
  });

  it("error trả về cho auth id là token sai", () => {
    const { fake, client, phase } = setup();
    client.start();
    const conn = fake.connections[0]!;
    conn.handlers.onOpen();
    conn.push({ id: conn.lastOfType("auth")!.id, type: "error", payload: { code: "UNAUTHENTICATED", message: "sai" } });
    expect(phase()).toBe("auth_failed");
  });

  it("backoffDelay tăng theo cấp số nhân và chặn trên", () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => backoffDelay(n, BACKOFF))).toEqual([100, 200, 400, 800, 1000, 1000]);
  });

  it("subscribe bị lỗi: đóng transport và kết nối lại thay vì kẹt ở syncing", async () => {
    const { fake, client, phase } = setup();
    client.start();
    const c1 = fake.connections[0]!;
    authOk(c1);
    expect(phase()).toBe("syncing");
    c1.push({ id: c1.lastOfType("subscribe")!.id, type: "error", payload: { code: "INTERNAL", message: "boom" } });
    await flush();
    expect(c1.closed).toBe(true);
    expect(phase()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(BACKOFF.initialMs);
    expect(fake.connections).toHaveLength(2);
    // Callback trễ của transport cũ bị bỏ qua.
    c1.handlers.onClose(1006, "");
    await vi.advanceTimersByTimeAsync(BACKOFF.maxMs);
    expect(fake.connections).toHaveLength(2);
  });

  it("subscribe hết hạn: kết nối lại", async () => {
    const { fake, client, phase } = setup();
    client.start();
    authOk(fake.connections[0]!);
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1);
    expect(fake.connections[0]!.closed).toBe(true);
    expect(phase()).toBe("reconnecting");
  });

  it("subscribe được ack: không kết nối lại; rớt mạng khi subscribe đang chờ chỉ lên lịch reconnect một lần", async () => {
    const a = setup();
    a.client.start();
    const conn = a.fake.connections[0]!;
    authOk(conn);
    conn.push({ id: conn.lastOfType("subscribe")!.id, type: "ack", payload: { result: { last_seq: 0 } } });
    conn.push({ id: "n", type: "replay.done", payload: { last_seq: 0 } });
    await vi.advanceTimersByTimeAsync(TIMEOUT * 3);
    expect(a.phase()).toBe("live");
    expect(a.fake.connections).toHaveLength(1);

    const b = setup();
    b.client.start();
    authOk(b.fake.connections[0]!);
    b.fake.connections[0]!.drop(1006);
    await flush();
    expect(b.states.filter((st) => st.phase === "reconnecting")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BACKOFF.initialMs);
    expect(b.fake.connections).toHaveLength(2);
  });

  it("Thử ngay khi đang kết nối: đóng transport cũ, bỏ qua callback trễ của nó", () => {
    const { fake, client, phase } = setup();
    client.start();
    fake.connections[0]!.drop(1006);
    vi.advanceTimersByTime(BACKOFF.initialMs);
    const c1 = fake.connections[1]!;
    expect(phase()).toBe("reconnecting");

    client.retryNow();
    expect(fake.connections).toHaveLength(3);
    expect(c1.closed).toBe(true);
    const c2 = fake.connections[2]!;

    // Kết nối cũ mở/đóng muộn: không gửi auth, không lên lịch reconnect.
    c1.handlers.onOpen();
    c1.handlers.onClose(1006, "late");
    expect(c1.sent).toHaveLength(0);
    vi.advanceTimersByTime(BACKOFF.maxMs);
    expect(fake.connections).toHaveLength(3);

    authOk(c2);
    expect(phase()).toBe("syncing");
  });

  it("bỏ qua message không phải JSON", () => {
    const { fake, client, messages } = setup();
    client.start();
    fake.connections[0]!.handlers.onMessage("not json");
    fake.connections[0]!.handlers.onMessage("[1,2]");
    expect(messages).toHaveLength(0);
  });
});

describe("LiveBridgeService + reconnect replay", () => {
  it("reconnect gửi since_seq cuối, mở lại luồng từ id cuối, không mất/trùng event", async () => {
    const fake = createFakeTransport();
    const store = createStore();
    const service = new LiveBridgeService(store, { transport: fake.factory });
    service.connect("ws://x/ws", "tok");

    // --- Kết nối 1
    const c1 = fake.connections[0]!;
    authOk(c1);
    expect(c1.lastOfType("subscribe")?.payload).toEqual({});
    const orch = { session_id: "o-1", claude_session_id: null, role: "orchestrator", project_key: "SH", repo: null, title: null, state: "active", busy: false, created_at: "", last_active_at: "" };
    c1.push({ id: "n", type: "state.snapshot", payload: { workers: [], tasks: [], tickets: [], sessions: [orch], pending_permissions: [], status: STATUS, last_seq: 2 } });
    c1.push({ id: "n", type: "bus.event", payload: busEvent(1) });
    c1.push({ id: "n", type: "bus.event", payload: busEvent(2) });
    c1.push({ id: "n", type: "replay.done", payload: { last_seq: 2 } });
    expect(store.getState().connection.phase).toBe("live");

    // onSynced: session.list rồi mở orchestrator.
    c1.push({ id: c1.lastOfType("session.list")!.id, type: "ack", payload: { result: [] } });
    await flush();
    const open1 = c1.lastOfType("session.open");
    expect(open1?.payload).toEqual({ session_id: "o-1" });
    c1.push({ id: open1!.id, type: "ack", payload: {} });
    c1.push({ id: "n", type: "session.history", payload: { session_id: "o-1", task_id: null, events: [record(1, {}, { session_id: "o-1" }), record(2, {}, { session_id: "o-1" })] } });
    c1.push({ id: "n", type: "bus.event", payload: busEvent(3) });

    // --- Rớt mạng
    c1.drop(1006);
    expect(store.getState().connection.phase).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2_000);

    // --- Kết nối 2
    const c2 = fake.connections[1]!;
    authOk(c2);
    expect(c2.lastOfType("subscribe")?.payload).toEqual({ since_seq: 3 });
    c2.push({ id: "n", type: "state.snapshot", payload: { workers: [], tasks: [], tickets: [], sessions: [orch], pending_permissions: [], status: STATUS, last_seq: 5 } });
    // Server replay chồng một event (3) để kiểm tra khử trùng.
    for (const seq of [3, 4, 5]) c2.push({ id: "n", type: "bus.event", payload: busEvent(seq) });
    c2.push({ id: "n", type: "replay.done", payload: { last_seq: 5 } });
    c2.push({ id: c2.lastOfType("session.list")!.id, type: "ack", payload: { result: [] } });
    await flush();

    expect(c2.lastOfType("session.open")?.payload).toEqual({ session_id: "o-1", since: 2 });
    expect(store.getState().events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(store.getState().lastSeq).toBe(5);
    expect(store.getState().streams[streamKeyForSession("o-1")]?.records.map((r) => r.id)).toEqual([1, 2]);
    service.disconnect();
  });
});
