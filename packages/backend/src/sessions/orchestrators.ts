// Orchestrator ×1 / project (mục 5.2): giữ session sống, chết thì tự spawn lại với resume (backoff, có trần),
// trạng thái alive → restarting → alive, hoặc dead sau N lần lỗi liên tiếp. Là đích của Wake Dispatcher.
import { existsSync } from "node:fs";
import type { OrchestratorHealth, Session } from "@claude-bridge/protocol";
import type { BridgeConfig } from "../config.js";
import type { Clock } from "../util/clock.js";
import { ListenerSet, type Unsubscribe } from "../util/listeners.js";
import type { Logger } from "../util/logger.js";
import type { TimerHandle, Timers } from "../util/timers.js";
import type { SessionEnded, SessionManager } from "./sessionManager.js";

export interface RestartPolicy {
  /** Backoff lần đầu, nhân đôi mỗi lần lỗi liên tiếp. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Quá số lần lỗi liên tiếp này thì dừng ở `dead`. */
  maxConsecutiveFailures: number;
  /** Process sống ít nhất chừng này rồi mới chết thì không tính là lỗi liên tiếp. */
  stableRunMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxConsecutiveFailures: 5,
  stableRunMs: 5 * 60_000,
};

interface Entry {
  project: string;
  health: OrchestratorHealth;
  failures: number;
  restartTimer: TimerHandle | null;
}

export interface OrchestratorDeps {
  config: BridgeConfig;
  sessions: SessionManager;
  timers: Timers;
  clock: Clock;
  log: Logger;
  policy?: RestartPolicy;
}

export class OrchestratorManager {
  private readonly entries = new Map<string, Entry>();
  private readonly policy: RestartPolicy;
  private readonly unsubscribers: Unsubscribe[];
  private stopped = false;
  private readonly healthChanged = new ListenerSet<{ project: string; health: OrchestratorHealth }>("orchestrator.health");
  private readonly idle = new ListenerSet<string>("orchestrator.idle");
  private readonly restarted = new ListenerSet<string>("orchestrator.restarted");

  constructor(private readonly deps: OrchestratorDeps) {
    this.policy = deps.policy ?? DEFAULT_RESTART_POLICY;
    for (const project of Object.keys(deps.config.orchestrators)) {
      this.entries.set(project, { project, health: "stopped", failures: 0, restartTimer: null });
    }
    this.unsubscribers = [
      deps.sessions.onLive((s) => this.onLive(s)),
      deps.sessions.onEnded((e) => this.onEnded(e)),
      deps.sessions.onTurnEnded((s) => this.onTurnEnded(s)),
    ];
  }

  onHealthChanged(cb: (e: { project: string; health: OrchestratorHealth }) => void): Unsubscribe {
    return this.healthChanged.add(cb);
  }
  /** Orchestrator sẵn sàng nhận turn (vừa spawn hoặc vừa xong turn). */
  onIdle(cb: (project: string) => void): Unsubscribe {
    return this.idle.add(cb);
  }
  /** Đã spawn lại sau sự cố; turn đang chạy lúc chết đã mất. */
  onRestarted(cb: (project: string) => void): Unsubscribe {
    return this.restarted.add(cb);
  }

  projects(): string[] {
    return [...this.entries.keys()];
  }

  has(project: string): boolean {
    return this.entries.has(project);
  }

  health(project: string | null): OrchestratorHealth {
    return (project ? this.entries.get(project)?.health : undefined) ?? "stopped";
  }

  /** Nhận trigger: đang sống hoặc đang khởi động lại (event được giữ tới khi sống lại). */
  acceptsWake(project: string): boolean {
    const h = this.health(project);
    return h === "alive" || h === "restarting";
  }

  isReady(project: string): boolean {
    const session = this.sessionFor(project);
    return this.health(project) === "alive" && session !== null && this.deps.sessions.isLive(session.session_id) && !session.busy;
  }

  sessionFor(project: string): Session | null {
    return this.deps.sessions.findOrchestrator(project);
  }

  /** Tạo (hoặc dùng lại) session của project và spawn process; resume theo claude_session_id nếu đã có. */
  start(project: string): Session | null {
    const entry = this.entries.get(project);
    if (!entry || this.stopped) return null;
    const cwd = this.deps.config.orchestrators[project]?.cwd;
    if (!cwd || !existsSync(cwd)) {
      this.deps.log.error({ project, cwd: cwd ?? null }, "orchestrator cwd does not exist");
      this.setHealth(entry, "dead");
      return null;
    }
    try {
      const session = this.sessionFor(project) ?? this.deps.sessions.createOrchestrator(project);
      this.deps.sessions.ensureLive(session.session_id);
    } catch (err) {
      this.deps.log.error({ err, project }, "cannot start orchestrator");
      this.scheduleRestart(entry);
      return this.sessionFor(project);
    }
    this.idle.emit(project);
    return this.sessionFor(project);
  }

  startAll(): void {
    for (const project of this.entries.keys()) this.start(project);
  }

  /** Bắt đầu nếu đang `stopped` (orchestrator_autostart = false: khi project được chọn / có tin nhắn). */
  ensureStarted(project: string): void {
    if (this.health(project) === "stopped") this.start(project);
  }

  sendSystemTurn(project: string, text: string): void {
    const session = this.sessionFor(project);
    if (!session) throw new Error(`orchestrator for ${project} has no session`);
    this.deps.sessions.sendText(session.session_id, text, "system");
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.unsubscribers) off();
    for (const entry of this.entries.values()) {
      if (entry.restartTimer !== null) this.deps.timers.clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
  }

  // ---- listeners của SessionManager --------------------------------------------------

  private entryFor(session: Session): Entry | null {
    if (session.role !== "orchestrator" || !session.project_key) return null;
    return this.entries.get(session.project_key) ?? null;
  }

  private onLive(session: Session): void {
    const entry = this.entryFor(session);
    if (!entry) return;
    // Người dùng nhắn vào orchestrator đã `dead`: bắt đầu lại bộ đếm lỗi.
    if (entry.health === "dead") entry.failures = 0;
    if (entry.restartTimer !== null) {
      this.deps.timers.clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
    this.setHealth(entry, "alive");
  }

  private onTurnEnded(session: Session): void {
    const entry = this.entryFor(session);
    if (!entry) return;
    entry.failures = 0;
    this.idle.emit(entry.project);
  }

  private onEnded(ended: SessionEnded): void {
    const entry = this.entryFor(ended.session);
    if (!entry || this.stopped || ended.expected) return;
    if (ended.ran_ms >= this.policy.stableRunMs) entry.failures = 0;
    this.scheduleRestart(entry);
  }

  private scheduleRestart(entry: Entry): void {
    entry.failures += 1;
    if (entry.failures > this.policy.maxConsecutiveFailures) {
      this.deps.log.error({ project: entry.project, failures: entry.failures - 1 }, "orchestrator keeps failing, giving up");
      this.setHealth(entry, "dead");
      return;
    }
    const delay = Math.min(this.policy.baseDelayMs * 2 ** (entry.failures - 1), this.policy.maxDelayMs);
    this.deps.log.warn({ project: entry.project, attempt: entry.failures, delay_ms: delay }, "restarting orchestrator");
    this.setHealth(entry, "restarting");
    if (entry.restartTimer !== null) this.deps.timers.clearTimeout(entry.restartTimer);
    entry.restartTimer = this.deps.timers.setTimeout(() => {
      entry.restartTimer = null;
      if (this.stopped || entry.health !== "restarting") return;
      // Callback của timer: lỗi lọt ra đây là uncaught exception của cả process.
      try {
        // start() đổi health qua onLive; đọc lại thay vì dùng giá trị đã thu hẹp kiểu.
        if (this.start(entry.project) && this.health(entry.project) === "alive") this.restarted.emit(entry.project);
      } catch (err) {
        this.deps.log.error({ err, project: entry.project }, "orchestrator restart failed");
        // Tính là một lần lỗi liên tiếp: thử lại theo backoff, quá trần thì `dead`.
        if (entry.health === "restarting" && entry.restartTimer === null) this.scheduleRestart(entry);
      }
    }, delay);
  }

  private setHealth(entry: Entry, health: OrchestratorHealth): void {
    if (entry.health === health) return;
    entry.health = health;
    this.healthChanged.emit({ project: entry.project, health });
  }
}
