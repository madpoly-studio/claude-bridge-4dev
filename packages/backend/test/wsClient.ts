// Client WebSocket cho test: ghi lại mọi message, chờ theo điều kiện, request/ack theo id.
import WebSocket from "ws";
import { ORIGIN, PAIRING_TOKEN } from "./helpers.js";

export interface Msg {
  id: string;
  type: string;
  payload: any;
}

export class TestWs {
  readonly messages: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  private n = 0;
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Msg;
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
    this.closed = new Promise((resolve) => socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  static open(url: string, origin: string | null = ORIGIN): Promise<TestWs> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, origin ? { origin } : {});
      const client = new TestWs(socket);
      socket.once("open", () => resolve(client));
      socket.once("error", reject);
      socket.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  waitFor(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  send(type: string, payload: unknown = {}): string {
    const id = `c-${++this.n}`;
    this.socket.send(JSON.stringify({ id, type, payload }));
    return id;
  }

  /** Gửi request, chờ ack / error cùng id. */
  async request(type: string, payload: unknown = {}): Promise<Msg> {
    const id = this.send(type, payload);
    return this.waitFor((m) => m.id === id && (m.type === "ack" || m.type === "error"));
  }

  close(): void {
    this.socket.close();
  }
}

/** Mở kết nối, auth bằng pairing token và subscribe (nhận snapshot). */
export async function openSubscribed(baseUrl: string): Promise<TestWs> {
  const ws = await TestWs.open(`${baseUrl.replace("http", "ws")}/ws`);
  const auth = await ws.request("auth", { token: PAIRING_TOKEN });
  if (auth.type !== "ack") throw new Error(`auth failed: ${JSON.stringify(auth.payload)}`);
  const sub = await ws.request("subscribe", {});
  if (sub.type !== "ack") throw new Error(`subscribe failed: ${JSON.stringify(sub.payload)}`);
  return ws;
}
