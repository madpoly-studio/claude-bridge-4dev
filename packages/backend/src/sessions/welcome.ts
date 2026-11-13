// Lời chào ghi vào luồng orchestrator khi backend khởi động: chỉ là event hiển thị (`bridge_welcome`), không phải turn
// Claude. Văn bản theo định dạng MessageText của web: đoạn cách nhau bằng dòng trống, `code` hiện font mono.
import type { Session, WakeMode } from "@claude-bridge/protocol";
import type { BridgeConfig, RepoConfig } from "../config.js";
import type { Clock } from "../util/clock.js";
import type { Unsubscribe } from "../util/listeners.js";
import type { Logger } from "../util/logger.js";
import type { SessionManager } from "./sessionManager.js";

export interface WelcomeDeps {
  config: BridgeConfig;
  sessions: SessionManager;
  clock: Clock;
  log: Logger;
}

/**
 * Ghi lời chào một lần cho mỗi project trong mỗi process backend, lúc orchestrator của project lên lần đầu sau `start()`:
 * orchestrator_autostart = true thì ngay trong startAll(); false thì khi project được chọn / có tin nhắn đầu tiên (lời chào
 * nằm trước tin nhắn đó). Crash-restart không chào lại.
 */
export class WelcomeAnnouncer {
  private startedAt: number | null = null;
  private readonly welcomed = new Set<string>();
  private readonly off: Unsubscribe;

  constructor(private readonly deps: WelcomeDeps) {
    this.off = deps.sessions.onLive((s) => this.onLive(s));
  }

  /** Gọi trước khi start orchestrator nào. */
  start(): void {
    this.startedAt ??= this.deps.clock.now();
  }

  stop(): void {
    this.off();
  }

  private onLive(session: Session): void {
    const project = session.project_key;
    if (this.startedAt === null || session.role !== "orchestrator" || !project || this.welcomed.has(project)) return;
    this.welcomed.add(project);
    const { config } = this.deps;
    try {
      const text = formatWelcome({
        startedAt: this.startedAt,
        projectKey: project,
        mode: config.wake_mode,
        repos: config.repos,
        agentLabel: config.agent_label,
        tickMinutes: config.orch_tick_minutes,
      });
      this.deps.sessions.recordWelcome(session.session_id, text);
    } catch (err) {
      // Chỉ là lời chào: lỗi ghi không được chặn orchestrator khởi động.
      this.deps.log.error({ err, project, session_id: session.session_id }, "failed to record orchestrator welcome");
    }
  }
}

export interface WelcomeInput {
  /** Lúc backend khởi động (ms). */
  startedAt: number;
  projectKey: string;
  mode: WakeMode;
  /** Toàn bộ `config.repos`; lọc theo `project_key` ở đây. */
  repos: readonly RepoConfig[];
  agentLabel: string;
  tickMinutes: number;
}

export function formatWelcome(input: WelcomeInput): string {
  const { projectKey, agentLabel } = input;
  const repos = input.repos.filter((r) => r.project_key === projectKey);
  const mode =
    input.mode === "manual"
      ? "Chế độ thủ công: orchestrator chỉ làm khi bạn yêu cầu, không tự nhận ticket. " +
        "Bridge chỉ báo lại khi task bạn giao xong hoặc lỗi."
      : "Chế độ tự động: orchestrator được đánh thức khi runner đăng ký worker, khi có ticket mới gắn label " +
        `\`${agentLabel}\` và mỗi ${input.tickMinutes} phút, rồi tự quyết định giao việc.`;
  const repoLines =
    repos.length > 0
      ? ["Repo của project:", ...repos.map((r) => `- \`${r.name}\` · ${r.path}`)]
      : [`Chưa có repo nào gắn project ${projectKey} trong cấu hình (\`repos[].project_key\`).`];
  return [
    `Bridge đã khởi động lúc ${formatLocalTime(input.startedAt)} · project \`${projectKey}\`.`,
    mode,
    [...repoLines, "Worker sẽ hiện ở tab Workers khi runner đăng ký."].join("\n"),
    [
      "Ví dụ yêu cầu:",
      `- Liệt kê các ticket label ${agentLabel} đang mở`,
      `- Giao ${projectKey}-123 cho worker rảnh`,
      "- Tình hình các worker?",
    ].join("\n"),
  ].join("\n\n");
}

/** `YYYY-MM-DD HH:mm` theo giờ máy chạy backend (cùng máy với người dùng, mục 12). */
function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
