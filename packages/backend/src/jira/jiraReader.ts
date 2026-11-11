// Jira Reader (mục 5.4): đọc hàng đợi ticket mở có label agent cho tab Tickets. Chỉ đọc, không bao giờ ghi Jira.
// Poll mỗi JIRA_POLL_SECONDS và ngay khi được yêu cầu (ticket.created, task.completed, task.failed); các yêu cầu
// trùng lúc đang đọc được gộp thành một lần đọc tiếp theo.
import type { SystemStatus, Ticket } from "@claude-bridge/protocol";
import { ListenerSet, type Unsubscribe } from "../util/listeners.js";
import type { Logger } from "../util/logger.js";
import type { TimerHandle, Timers } from "../util/timers.js";
import { JiraClient } from "./jiraClient.js";
import { TICKET_FIELDS, mapIssue, ticketQueueJql } from "./jiraMapping.js";
import type { JiraSettingsResult } from "./jiraSettings.js";

export type JiraStatus = SystemStatus["jira"];

export interface JiraReaderDeps {
  settings: JiraSettingsResult;
  /** Project key từ cấu hình bridge; rỗng thì dùng MPS_JIRA_PROJECT_KEY. */
  projects: readonly string[];
  agentLabel: string;
  pollMs: number;
  timers: Timers;
  log: Logger;
}

export class JiraReader {
  private readonly client: JiraClient | null;
  private readonly projects: string[];
  private cache: Ticket[] = [];
  private cacheJson = "[]";
  private state: JiraStatus;
  private running: Promise<void> | null = null;
  private again = false;
  private pollTimer: TimerHandle | null = null;
  private stopped = false;
  private readonly ticketsChanged = new ListenerSet<Ticket[]>("jira.tickets");
  private readonly statusChanged = new ListenerSet<JiraStatus>("jira.status");

  constructor(private readonly deps: JiraReaderDeps) {
    const s = deps.settings;
    this.projects = s.status === "ok" && deps.projects.length === 0 && s.settings.projectKey ? [s.settings.projectKey] : [...deps.projects];
    if (s.status === "ok" && this.projects.length > 0) {
      this.client = new JiraClient(s.settings);
      this.state = "unconfigured";
    } else {
      this.client = null;
      this.state = s.status === "error" ? "error" : "unconfigured";
      const reason = s.status === "ok" ? "no project configured" : s.reason;
      deps.log.warn({ jira: this.state, reason }, "jira reader disabled");
    }
  }

  onTicketsChanged(cb: (tickets: Ticket[]) => void): Unsubscribe {
    return this.ticketsChanged.add(cb);
  }

  onStatusChanged(cb: (status: JiraStatus) => void): Unsubscribe {
    return this.statusChanged.add(cb);
  }

  tickets(): Ticket[] {
    return this.cache;
  }

  status(): JiraStatus {
    return this.state;
  }

  configured(): boolean {
    return this.client !== null;
  }

  start(): void {
    if (!this.client || this.pollTimer !== null) return;
    this.stopped = false;
    void this.refresh();
    this.pollTimer = this.deps.timers.setInterval(() => void this.refresh(), this.deps.pollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer !== null) this.deps.timers.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.client?.close();
  }

  /** Đọc lại ngay; đang đọc thì hẹn thêm đúng một lần sau lần hiện tại. Resolve khi dữ liệu đã mới. */
  refresh(): Promise<void> {
    if (!this.client) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      await this.fetchOnce();
    } while (this.again && !this.stopped);
  }

  private async fetchOnce(): Promise<void> {
    const client = this.client as JiraClient;
    const s = this.deps.settings;
    const baseUrl = s.status === "ok" ? s.settings.baseUrl : "";
    try {
      const tickets: Ticket[] = [];
      for (const project of this.projects) {
        const issues = await client.searchAll(ticketQueueJql(project, this.deps.agentLabel), TICKET_FIELDS);
        tickets.push(...issues.map((issue) => mapIssue(issue, baseUrl)));
      }
      if (this.stopped) return;
      this.setStatus("ok");
      const json = JSON.stringify(tickets);
      if (json !== this.cacheJson) {
        this.cache = tickets;
        this.cacheJson = json;
        this.ticketsChanged.emit(tickets);
      }
    } catch (err) {
      if (this.stopped) return;
      this.deps.log.warn({ err: (err as Error).message }, "jira poll failed");
      this.setStatus("error");
    }
  }

  private setStatus(status: JiraStatus): void {
    if (this.state === status) return;
    this.state = status;
    this.statusChanged.emit(status);
  }
}
