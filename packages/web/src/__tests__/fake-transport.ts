import type { Transport, TransportFactory, TransportHandlers } from "../ws/transport";

export interface FakeConnection {
  url: string;
  handlers: TransportHandlers;
  sent: Array<{ id: string; type: string; payload: Record<string, unknown> }>;
  closed: boolean;
  /** Server gửi message xuống client. */
  push(message: unknown): void;
  /** Server đóng kết nối. */
  drop(code?: number, reason?: string): void;
  lastOfType(type: string): { id: string; type: string; payload: Record<string, unknown> } | undefined;
}

/** Transport giả: ghi lại mọi kết nối để test điều khiển phía "server". */
export function createFakeTransport(): { factory: TransportFactory; connections: FakeConnection[] } {
  const connections: FakeConnection[] = [];
  const factory: TransportFactory = (url, handlers) => {
    const conn: FakeConnection = {
      url,
      handlers,
      sent: [],
      closed: false,
      push: (message) => handlers.onMessage(JSON.stringify(message)),
      drop: (code = 1006, reason = "") => {
        conn.closed = true;
        handlers.onClose(code, reason);
      },
      lastOfType: (type) => [...conn.sent].reverse().find((m) => m.type === type),
    };
    connections.push(conn);
    const transport: Transport = {
      send: (data) => conn.sent.push(JSON.parse(data)),
      close: () => {
        conn.closed = true;
      },
    };
    return transport;
  };
  return { factory, connections };
}
