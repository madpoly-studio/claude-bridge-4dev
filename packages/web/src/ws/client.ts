// Client message của bridge: request/response theo id, auth + subscribe, tự kết nối lại có backoff.
// Không phụ thuộc WebSocket: transport được tiêm qua TransportFactory.
import { WS_CLOSE } from "@claude-bridge/protocol";
import type { ClientMessageType, ClientPayloads, ServerMessage } from "@claude-bridge/protocol";
import { REQUEST_TIMEOUT_MS, RECONNECT_BACKOFF } from "../config";
import { newId } from "../lib/id";
import { ABNORMAL_CLOSE, NORMAL_CLOSE, webSocketTransport } from "./transport";
import type { Transport, TransportFactory } from "./transport";

export type ConnectionPhase =
  | "idle"
  | "connecting"
  | "authenticating"
  /** Đã auth, đã subscribe, đang nhận snapshot + replay. */
  | "syncing"
  | "live"
  | "reconnecting"
  | "auth_failed"
  | "origin_rejected"
  | "stopped";

export interface ConnectionState {
  phase: ConnectionPhase;
  error: string | null;
  /** Số lần thử lại liên tiếp kể từ lần auth thành công gần nhất. */
  attempt: number;
  /** epoch ms của lần thử lại kế tiếp khi phase = reconnecting. */
  retryAt: number | null;
}

export const INITIAL_CONNECTION: ConnectionState = { phase: "idle", error: null, attempt: 0, retryAt: null };

export class BridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
}

export interface BridgeClientOptions {
  url: string;
  token: string;
  /** seq cuối đã nhận; undefined khi chưa có gì (để backend tự quyết replay). */
  getSinceSeq: () => number | undefined;
  onMessage: (msg: ServerMessage) => void;
  onConnection: (state: ConnectionState) => void;
  transport?: TransportFactory;
  requestTimeoutMs?: number;
  backoff?: BackoffOptions;
  now?: () => number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: BridgeRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const READY_PHASES: readonly ConnectionPhase[] = ["syncing", "live"];

export function backoffDelay(attempt: number, opts: BackoffOptions): number {
  return Math.min(opts.maxMs, opts.initialMs * Math.pow(opts.factor, attempt));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class BridgeClient {
  private readonly opts: Required<Omit<BridgeClientOptions, "getSinceSeq" | "onMessage" | "onConnection">> &
    Pick<BridgeClientOptions, "getSinceSeq" | "onMessage" | "onConnection">;
  private transport: Transport | null = null;
  private generation = 0;
  private pending = new Map<string, PendingRequest>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private authId: string | null = null;
  private stopped = true;
  private state: ConnectionState = INITIAL_CONNECTION;

  constructor(options: BridgeClientOptions) {
    // `??` thay vì spread: caller có thể truyền tường minh `undefined` (vd. LiveBridgeService
    // chuyển tiếp option không đặt), spread sẽ ghi đè mặc định bằng undefined.
    this.opts = {
      ...options,
      transport: options.transport ?? webSocketTransport,
      requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      backoff: options.backoff ?? RECONNECT_BACKOFF,
      now: options.now ?? (() => Date.now()),
    };
  }

  get connection(): ConnectionState {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.setState({ phase: "connecting", error: null, attempt: 0, retryAt: null });
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.generation++;
    const t = this.transport;
    this.transport = null;
    try {
      t?.close(NORMAL_CLOSE, "client stop");
    } catch {
      // ignore
    }
    this.rejectAll("DISCONNECTED", "Đã ngắt kết nối");
    this.setState({ phase: "stopped", error: null, attempt: 0, retryAt: null });
  }

  /** Bỏ qua thời gian chờ backoff, thử lại ngay. */
  retryNow(): void {
    if (this.stopped || this.state.phase !== "reconnecting") return;
    this.clearTimers();
    this.open();
  }

  request<K extends ClientMessageType>(type: K, payload: ClientPayloads[K]): Promise<unknown> {
    if (!READY_PHASES.includes(this.state.phase) || !this.transport) {
      return Promise.reject(new BridgeRequestError("NOT_CONNECTED", "Chưa kết nối backend"));
    }
    return this.sendRequest(type, payload);
  }

  // -------------------------------------------------------------------------

  private sendRequest<K extends ClientMessageType>(type: K, payload: ClientPayloads[K]): Promise<unknown> {
    const id = newId();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeRequestError("TIMEOUT", `Hết thời gian chờ phản hồi cho ${type}`));
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport?.send(JSON.stringify({ id, type, payload }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeRequestError("SEND_FAILED", e instanceof Error ? e.message : "Không gửi được"));
      }
    });
  }

  private open(): void {
    // Bỏ transport cũ (vd. bấm "Thử ngay" khi lần kết nối trước còn đang mở): tăng generation
    // để callback trễ của nó bị bỏ qua, rồi đóng để không rò WebSocket.
    const prev = this.transport;
    this.transport = null;
    this.authId = null;
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
    const gen = ++this.generation;
    if (prev) {
      this.rejectAll("DISCONNECTED", "Kết nối được thay thế");
      try {
        prev.close(NORMAL_CLOSE, "superseded");
      } catch {
        // ignore
      }
    }
    const guard =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        if (gen === this.generation) fn(...args);
      };
    this.setState({ ...this.state, phase: this.state.attempt > 0 ? "reconnecting" : "connecting", retryAt: null });
    try {
      this.transport = this.opts.transport(this.opts.url, {
        onOpen: guard(() => this.handleOpen()),
        onMessage: guard((data: string) => this.handleMessage(data)),
        onClose: guard((code: number, reason: string) => this.handleClose(code, reason)),
      });
    } catch (e) {
      this.transport = null;
      this.handleClose(ABNORMAL_CLOSE, e instanceof Error ? e.message : "Không mở được kết nối");
    }
  }

  private handleOpen(): void {
    this.setState({ ...this.state, phase: "authenticating", error: null });
    const id = newId();
    this.authId = id;
    this.authTimer = setTimeout(() => {
      // Không nhận được auth.ok: bỏ transport hiện tại rồi thử lại.
      this.abandonTransport(WS_CLOSE.AUTH_TIMEOUT, "Hết thời gian xác thực");
    }, this.opts.requestTimeoutMs);
    try {
      this.transport?.send(JSON.stringify({ id, type: "auth", payload: { token: this.opts.token } }));
    } catch {
      // onClose sẽ xử lý.
    }
  }

  private handleMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") return;
    const msg = parsed as unknown as ServerMessage;
    const id = typeof parsed.id === "string" ? parsed.id : "";

    if (msg.type === "ack" || msg.type === "error") {
      if (id && id === this.authId && msg.type === "error") {
        this.failAuth(msg.payload?.message ?? "Token không hợp lệ");
        return;
      }
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (msg.type === "ack") p.resolve(msg.payload?.result);
        else p.reject(new BridgeRequestError(msg.payload?.code ?? "ERROR", msg.payload?.message ?? "Lỗi không rõ"));
        return;
      }
      if (msg.type === "ack") return;
    }

    if (msg.type === "auth.ok") {
      this.authId = null;
      if (this.authTimer) clearTimeout(this.authTimer);
      this.authTimer = null;
      this.setState({ phase: "syncing", error: null, attempt: 0, retryAt: null });
      this.opts.onMessage(msg);
      const since = this.opts.getSinceSeq();
      // Phản hồi của subscribe là snapshot + replay; ack không cần dùng. Lỗi/hết hạn thì kết nối
      // này vô dụng (kẹt ở "syncing"): bỏ nó và đi đường reconnect bình thường.
      const gen = this.generation;
      const transport = this.transport;
      this.sendRequest("subscribe", since === undefined ? {} : { since_seq: since }).catch(() => {
        // Đã rớt/đổi kết nối (handleClose, stop, open mới) thì không làm gì thêm.
        if (this.stopped || gen !== this.generation || !transport || this.transport !== transport) return;
        this.abandonTransport(ABNORMAL_CLOSE, "subscribe failed");
      });
      return;
    }

    if (msg.type === "replay.done") {
      this.opts.onMessage(msg);
      this.setState({ ...this.state, phase: "live" });
      return;
    }

    this.opts.onMessage(msg);
  }

  /** Đóng transport hiện tại, bỏ qua callback trễ của nó (tăng generation), rồi xử lý như mất kết nối. */
  private abandonTransport(code: number, reason: string): void {
    const stale = this.transport;
    this.generation++;
    this.transport = null;
    try {
      stale?.close(NORMAL_CLOSE, reason);
    } catch {
      // ignore
    }
    this.handleClose(code, reason);
  }

  private failAuth(message: string): void {
    this.stopped = true;
    this.clearTimers();
    this.generation++;
    try {
      this.transport?.close(NORMAL_CLOSE, "auth failed");
    } catch {
      // ignore
    }
    this.transport = null;
    this.rejectAll("UNAUTHENTICATED", message);
    this.setState({ phase: "auth_failed", error: message, attempt: 0, retryAt: null });
  }

  private handleClose(code: number, reason: string): void {
    this.transport = null;
    this.authId = null;
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
    this.rejectAll("DISCONNECTED", "Mất kết nối backend");
    if (this.stopped) return;

    if (code === WS_CLOSE.AUTH_FAILED) {
      this.failAuth(reason || "Token không hợp lệ");
      return;
    }
    if (code === WS_CLOSE.ORIGIN_REJECTED) {
      this.stopped = true;
      this.clearTimers();
      this.setState({
        phase: "origin_rejected",
        error: reason || "Origin của trang không nằm trong allowed_origins của backend",
        attempt: 0,
        retryAt: null,
      });
      return;
    }

    const attempt = this.state.attempt;
    const delay = backoffDelay(attempt, this.opts.backoff);
    this.setState({
      phase: "reconnecting",
      error: reason || null,
      attempt: attempt + 1,
      retryAt: this.opts.now() + delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private rejectAll(code: string, message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeRequestError(code, message));
      this.pending.delete(id);
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.authTimer) clearTimeout(this.authTimer);
    this.reconnectTimer = null;
    this.authTimer = null;
  }

  private setState(next: ConnectionState): void {
    this.state = next;
    this.opts.onConnection(next);
  }
}
