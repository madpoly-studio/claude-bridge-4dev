// WebSocket hub tại `/ws` (mục 9): Auth Gate, envelope {id,type,payload}, registry handler mở rộng được.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import {
  type BusEvent,
  type ClientMessageType,
  type ClientPayloads,
  type PermissionRequest,
  type ServerMessageType,
  type ServerPayloads,
  type Session,
  type SystemStatus,
  type Task,
  type Ticket,
  type Worker,
  type WsErrorCode,
  WS_CLOSE,
} from "@claude-bridge/protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { BusError } from "../bus/errors.js";
import { type AuthPrincipal, type TokenVerifier, isOriginAllowed } from "./auth.js";

export const WS_PATH = "/ws";
export const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Lỗi trả về client dạng `error {code, message}`. */
export class WsError extends Error {
  constructor(
    readonly code: WsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WsError";
  }
}

export interface WsClient {
  readonly id: string;
  readonly principal: AuthPrincipal | null;
  /** true sau khi `subscribe` xong (đã nhận snapshot + replay). */
  readonly subscribed: boolean;
  readonly openSessionIds: ReadonlySet<string>;
  readonly openTaskIds: ReadonlySet<string>;
  send<K extends ServerMessageType>(type: K, payload: ServerPayloads[K], id?: string): void;
  /** Đăng ký nhận `session.event` của một session (dùng cho `session.open`). */
  openSession(sessionId: string): void;
  closeSession(sessionId: string): void;
  /** Đăng ký nhận `session.event` của một task (dùng cho `task.open`). */
  openTask(taskId: string): void;
}

export interface HandlerContext {
  client: WsClient;
  /** `id` của envelope request; ack / error dùng lại id này. */
  requestId: string;
}

export type WsHandler<K extends ClientMessageType> = (ctx: HandlerContext, payload: ClientPayloads[K]) => unknown;

export interface SnapshotCore {
  workers: Worker[];
  tasks: Task[];
  status: SystemStatus;
  last_seq: number;
}

export interface SnapshotContribution {
  sessions?: Session[];
  tickets?: Ticket[];
  pending_permissions?: PermissionRequest[];
}
/** Đồng bộ, đọc từ DB / bộ nhớ: subscribe dựng snapshot + replay trong một tick để không lọt event. */
export type SnapshotContributor = () => SnapshotContribution;

export interface WsHubLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WsHubOptions {
  allowedOrigins: readonly string[];
  verifier: TokenVerifier;
  authTimeoutMs?: number;
  authOk: () => ServerPayloads["auth.ok"];
  snapshotCore: () => SnapshotCore;
  /** Bus event có seq > sinceSeq. */
  replay: (sinceSeq: number) => BusEvent[];
  log: WsHubLogger;
}

interface HandlerEntry {
  schema: z.ZodType;
  handler: (ctx: HandlerContext, payload: unknown) => unknown;
}

const envelopeSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  payload: z.unknown().optional(),
});

const subscribeSchema = z.object({ since_seq: z.number().int().min(0).optional() });
const authSchema = z.object({ token: z.string().min(1).max(4096) });

class HubClient implements WsClient {
  readonly id = randomUUID();
  principal: AuthPrincipal | null = null;
  subscribed = false;
  readonly openSessionIds = new Set<string>();
  readonly openTaskIds = new Set<string>();
  alive = true;
  /** Xử lý tuần tự message của một client (subscribe trước task.open, ...). */
  queue: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(readonly socket: WebSocket) {}

  send<K extends ServerMessageType>(type: K, payload: ServerPayloads[K], id?: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ id: id ?? `s-${++this.seq}`, type, payload }));
  }

  openSession(sessionId: string): void {
    this.openSessionIds.add(sessionId);
  }

  closeSession(sessionId: string): void {
    this.openSessionIds.delete(sessionId);
  }

  openTask(taskId: string): void {
    this.openTaskIds.add(taskId);
  }
}

export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly clients = new Set<HubClient>();
  private readonly handlers = new Map<string, HandlerEntry>();
  private readonly contributors = new Set<SnapshotContributor>();
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly authTimeoutMs: number;

  constructor(private readonly opts: WsHubOptions) {
    this.authTimeoutMs = opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.registerHandler("subscribe", subscribeSchema, (ctx, payload) => this.handleSubscribe(ctx, payload));
  }

  // ---- extension points ----------------------------------------------------------

  /**
   * Đăng ký (hoặc thay thế) handler cho một type C→S. `schema` validate payload; giá trị trả về
   * thành `ack {result}`; throw WsError / BusError thành `error`.
   */
  registerHandler<K extends ClientMessageType>(type: K, schema: z.ZodType, handler: WsHandler<K>): void {
    if (type === "auth") throw new Error("auth is handled by the Auth Gate");
    this.handlers.set(type, { schema, handler: handler as HandlerEntry["handler"] });
  }

  registerSnapshotContributor(contributor: SnapshotContributor): () => void {
    this.contributors.add(contributor);
    return () => {
      this.contributors.delete(contributor);
    };
  }

  /** Gửi tới mọi client đã subscribe. */
  broadcast<K extends ServerMessageType>(type: K, payload: ServerPayloads[K]): void {
    for (const c of this.clients) if (c.subscribed) c.send(type, payload);
  }

  /** Gửi tới client đã mở session (session.open) — dùng cho session.updated, permission.*, ... */
  sendToSubscribersOfSession<K extends ServerMessageType>(sessionId: string, type: K, payload: ServerPayloads[K]): void {
    for (const c of this.clients) if (c.openSessionIds.has(sessionId)) c.send(type, payload);
  }

  /** Định tuyến một dòng session_events tới client đã mở session hoặc task tương ứng. */
  routeSessionEvent(record: ServerPayloads["session.event"]): void {
    for (const c of this.clients) {
      if (c.openSessionIds.has(record.session_id) || (record.task_id !== null && c.openTaskIds.has(record.task_id))) {
        c.send("session.event", record);
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  // ---- lifecycle ---------------------------------------------------------------

  attach(server: HttpServer): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.onUpgrade(req, socket, head));
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.clients) c.socket.close(1001, "server shutting down");
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? "").split("?")[0];
    if (path !== WS_PATH) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin, this.opts.allowedOrigins)) {
      this.opts.log.warn({ origin: origin ?? null }, "ws upgrade rejected: origin not allowed");
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(socket: WebSocket): void {
    const client = new HubClient(socket);
    this.clients.add(client);
    const authTimer = setTimeout(() => {
      if (!client.principal) socket.close(WS_CLOSE.AUTH_TIMEOUT, "auth timeout");
    }, this.authTimeoutMs);
    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("message", (data: RawData) => {
      client.queue = client.queue.then(() => this.onMessage(client, data));
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      this.clients.delete(client);
    });
    socket.on("error", (err) => this.opts.log.warn({ err: err.message }, "ws socket error"));
  }

  private pingAll(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }

  private async onMessage(client: HubClient, data: RawData): Promise<void> {
    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = envelopeSchema.parse(JSON.parse(rawToString(data)));
    } catch {
      client.send("error", { code: "BAD_REQUEST", message: "message must be a JSON envelope {id, type, payload}" });
      if (!client.principal) client.socket.close(WS_CLOSE.AUTH_FAILED, "auth required");
      return;
    }
    if (!client.principal) {
      await this.authenticate(client, envelope);
      return;
    }
    await this.dispatch(client, envelope);
  }

  private async authenticate(client: HubClient, envelope: z.infer<typeof envelopeSchema>): Promise<void> {
    const parsed = authSchema.safeParse(envelope.payload);
    const principal = envelope.type === "auth" && parsed.success ? await this.opts.verifier.verify(parsed.data.token) : null;
    if (!principal) {
      client.send("error", { code: "UNAUTHENTICATED", message: "first message must be auth with a valid token" }, envelope.id);
      client.socket.close(WS_CLOSE.AUTH_FAILED, "auth failed");
      return;
    }
    client.principal = principal;
    const ok = this.opts.authOk();
    client.send("auth.ok", ok, envelope.id);
    client.send("ack", { result: ok }, envelope.id);
  }

  private async dispatch(client: HubClient, envelope: z.infer<typeof envelopeSchema>): Promise<void> {
    const entry = this.handlers.get(envelope.type);
    if (!entry) {
      client.send("error", { code: "BAD_REQUEST", message: `unknown message type ${envelope.type}` }, envelope.id);
      return;
    }
    const parsed = entry.schema.safeParse(envelope.payload ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(payload)"}: ${i.message}`).join("; ");
      client.send("error", { code: "BAD_REQUEST", message: detail }, envelope.id);
      return;
    }
    try {
      const result = await entry.handler({ client, requestId: envelope.id }, parsed.data);
      client.send("ack", result === undefined ? {} : { result }, envelope.id);
    } catch (err) {
      if (err instanceof WsError || err instanceof BusError) {
        client.send("error", { code: err.code, message: err.message }, envelope.id);
        return;
      }
      this.opts.log.error({ err, type: envelope.type }, "ws handler failed");
      client.send("error", { code: "INTERNAL", message: "internal error" }, envelope.id);
    }
  }

  /** Snapshot → replay bus event seq > since_seq → replay.done, đồng bộ trong một tick. */
  private handleSubscribe(ctx: HandlerContext, payload: unknown): { last_seq: number } {
    const { since_seq } = payload as z.infer<typeof subscribeSchema>;
    const client = ctx.client as HubClient;
    const core = this.opts.snapshotCore();
    const extra: Required<SnapshotContribution> = { sessions: [], tickets: [], pending_permissions: [] };
    for (const contribute of this.contributors) {
      const part = contribute();
      if (part.sessions) extra.sessions.push(...part.sessions);
      if (part.tickets) extra.tickets.push(...part.tickets);
      if (part.pending_permissions) extra.pending_permissions.push(...part.pending_permissions);
    }
    client.send("state.snapshot", { ...core, ...extra });
    if (since_seq !== undefined) {
      for (const event of this.opts.replay(since_seq)) {
        if (event.seq > core.last_seq) break;
        client.send("bus.event", event);
      }
    }
    client.send("replay.done", { last_seq: core.last_seq });
    client.subscribed = true;
    return { last_seq: core.last_seq };
  }
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
