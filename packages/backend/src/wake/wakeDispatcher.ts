// Wake Dispatcher (mục 8): gộp trigger hệ thống trong cửa sổ WAKE_DEBOUNCE_SECONDS thành một turn `[bridge-event]`
// (origin system) cho orchestrator của project; orchestrator đang giữa turn thì giữ lại, gửi gộp khi turn kết thúc.
import { type BusEvent, type WakeEvent, formatWakeTurn } from "@claude-bridge/protocol";
import type { EventLog } from "../events/eventLog.js";
import type { Unsubscribe } from "../util/listeners.js";
import type { Logger } from "../util/logger.js";
import type { TimerHandle, Timers } from "../util/timers.js";

/** Đích của turn hệ thống; OrchestratorManager cài đặt. */
export interface WakeTarget {
  projects(): string[];
  /** Có nhận trigger không (đang sống hoặc đang khởi động lại). */
  acceptsWake(project: string): boolean;
  /** Sống và không giữa turn. */
  isReady(project: string): boolean;
  sendSystemTurn(project: string, text: string): void;
  onIdle(cb: (project: string) => void): Unsubscribe;
  onRestarted(cb: (project: string) => void): Unsubscribe;
  onHealthChanged(cb: (e: { project: string }) => void): Unsubscribe;
}

export interface WakeDispatcherDeps {
  eventLog: EventLog;
  target: WakeTarget;
  timers: Timers;
  debounceMs: number;
  tickMs: number;
  log: Logger;
}

interface Pending {
  events: WakeEvent[];
  keys: Set<string>;
  /** Cửa sổ debounce đang mở (tính từ trigger đầu tiên). */
  window: TimerHandle | null;
}

export class WakeDispatcher {
  private readonly pending = new Map<string, Pending>();
  private unsubscribers: Unsubscribe[] = [];
  private tickTimer: TimerHandle | null = null;

  constructor(private readonly deps: WakeDispatcherDeps) {}

  start(): void {
    if (this.unsubscribers.length > 0) return;
    const { eventLog, target, timers } = this.deps;
    this.unsubscribers = [
      eventLog.onBusEvent((e) => this.onBusEvent(e)),
      target.onIdle((project) => this.tryFlush(project)),
      // Turn đang chạy lúc orchestrator chết đã mất: nhắc nó dựng lại toàn cảnh.
      target.onRestarted((project) => this.enqueue(project, { type: "tick" })),
      // Orchestrator dead / dừng: event đang giữ không còn nơi nhận; lần khởi động sau nó tự dựng lại toàn cảnh.
      target.onHealthChanged(({ project }) => {
        if (!target.acceptsWake(project)) this.drop(project);
      }),
    ];
    // Bắt buộc giữ: ticket tạo tay trên Jira không có thông báo nào khác (mục 8).
    this.tickTimer = timers.setInterval(() => {
      for (const project of target.projects()) this.enqueue(project, { type: "tick" });
    }, this.deps.tickMs);
  }

  stop(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    if (this.tickTimer !== null) this.deps.timers.clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const p of this.pending.values()) if (p.window !== null) this.deps.timers.clearTimeout(p.window);
    this.pending.clear();
  }

  /** Event đang chờ gửi của project (cho test / chẩn đoán). */
  pendingEvents(project: string): WakeEvent[] {
    return [...(this.pending.get(project)?.events ?? [])];
  }

  enqueue(project: string, event: WakeEvent): void {
    if (!this.deps.target.acceptsWake(project)) {
      // Orchestrator chưa chạy / đã dead: khi khởi động nó tự dựng lại toàn cảnh, không cần giữ event.
      this.deps.log.debug({ project, event }, "wake event dropped: orchestrator not running");
      return;
    }
    let p = this.pending.get(project);
    if (!p) {
      p = { events: [], keys: new Set(), window: null };
      this.pending.set(project, p);
    }
    const key = JSON.stringify(event);
    if (p.keys.has(key)) return;
    p.keys.add(key);
    p.events.push(event);
    if (p.window === null && p.events.length === 1) this.openWindow(project, p);
  }

  private drop(project: string): void {
    const p = this.pending.get(project);
    if (!p) return;
    if (p.window !== null) this.deps.timers.clearTimeout(p.window);
    this.pending.delete(project);
    this.deps.log.warn({ project, dropped: p.events.length }, "orchestrator unavailable, wake events dropped");
  }

  private onBusEvent(event: BusEvent): void {
    const projects = this.deps.target.projects();
    const byTicket = (): string | null => {
      const prefix = event.ticket_key?.split("-")[0];
      return prefix && projects.includes(prefix) ? prefix : null;
    };
    switch (event.type) {
      case "ticket.created": {
        if (event.payload.has_agent_label !== true) return;
        const project = byTicket();
        if (project && event.ticket_key) this.enqueue(project, { type: "ticket.created", ticket_key: event.ticket_key });
        return;
      }
      case "task.completed":
      case "task.failed": {
        const project = byTicket();
        if (!project) return;
        const wake: WakeEvent = { type: event.type };
        if (event.task_id) wake.task_id = event.task_id;
        if (event.ticket_key) wake.ticket_key = event.ticket_key;
        if (event.type === "task.failed" && typeof event.payload.category === "string") wake.category = event.payload.category;
        this.enqueue(project, wake);
        return;
      }
      case "worker.registered": {
        if (!event.worker_id) return;
        for (const project of projects) this.enqueue(project, { type: "worker.registered", worker_id: event.worker_id });
        return;
      }
      default:
        return;
    }
  }

  /** Gửi khi cửa sổ debounce đã đóng và orchestrator rảnh; ngược lại giữ tới onIdle / hết cửa sổ. */
  private tryFlush(project: string): void {
    const p = this.pending.get(project);
    if (!p || p.events.length === 0 || p.window !== null) return;
    if (!this.deps.target.isReady(project)) return;
    const events = p.events;
    this.pending.delete(project);
    try {
      this.deps.target.sendSystemTurn(project, formatWakeTurn(events));
      this.deps.log.info({ project, count: events.length }, "orchestrator woken");
    } catch (err) {
      this.deps.log.error({ err, project }, "failed to send wake turn; events kept, retrying after the debounce window");
      // Events mới tới sau đó không mở cửa sổ (chỉ event đầu tiên mở) và có thể không còn onIdle nào nữa:
      // tự hẹn lần thử lại để event không kẹt. Orchestrator dead / dừng thì drop() hủy timer này.
      const retry: Pending = { events, keys: new Set(events.map((e) => JSON.stringify(e))), window: null };
      this.pending.set(project, retry);
      this.openWindow(project, retry);
    }
  }

  private openWindow(project: string, p: Pending): void {
    p.window = this.deps.timers.setTimeout(() => {
      p.window = null;
      this.tryFlush(project);
    }, this.deps.debounceMs);
  }
}
