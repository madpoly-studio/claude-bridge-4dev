// Hồi quy: option mặc định của BridgeClient phải chịu được giá trị `undefined` truyền tường minh.
// LiveBridgeService không có option chuyển tiếp `transport: undefined`; trước đây spread ghi đè
// webSocketTransport bằng undefined nên trình duyệt không bao giờ mở WebSocket (kẹt "reconnecting").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../ws/client";
import type { ConnectionState } from "../ws/client";
import { LiveBridgeService } from "../services/live-bridge-service";
import { createStore } from "../state/store";

const URL = "ws://127.0.0.1:8787/ws";
const ABNORMAL_CLOSE = 1006;

/** WebSocket tối thiểu: ghi lại url và message đã gửi, test tự gọi onopen/onclose. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    // Không cần mô phỏng close frame.
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("BridgeClient: mặc định khi option là undefined", () => {
  it("LiveBridgeService không có transport vẫn mở WebSocket thật tới url", () => {
    const store = createStore();
    const service = new LiveBridgeService(store);
    service.connect(URL, "tok");

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toBe(URL);
    expect(store.getState().connection.phase).toBe("connecting");

    FakeWebSocket.instances[0]!.onopen?.();
    expect(JSON.parse(FakeWebSocket.instances[0]!.sent[0]!)).toMatchObject({ type: "auth", payload: { token: "tok" } });
    expect(store.getState().connection.phase).toBe("authenticating");
    service.disconnect();
  });

  it("requestTimeoutMs/backoff/now undefined dùng giá trị mặc định", () => {
    const states: ConnectionState[] = [];
    const client = new BridgeClient({
      url: URL,
      token: "tok",
      transport: undefined,
      requestTimeoutMs: undefined,
      backoff: undefined,
      now: undefined,
      getSinceSeq: () => undefined,
      onMessage: () => {},
      onConnection: (s) => states.push(s),
    });
    client.start();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0]!.onclose?.({ code: ABNORMAL_CLOSE, reason: "" });
    const last = states[states.length - 1]!;
    expect(last.phase).toBe("reconnecting");
    expect(last.attempt).toBe(1);
    expect(Number.isFinite(last.retryAt)).toBe(true);
    client.stop();
  });
});
