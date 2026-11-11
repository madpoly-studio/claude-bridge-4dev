// Ghép Jira Reader vào hub (tickets.updated, snapshot, tickets.refresh), status.jira và trigger từ bus.
import type { BridgeConfig } from "../config.js";
import type { EventLog } from "../events/eventLog.js";
import type { StatusService } from "../status/statusService.js";
import type { Unsubscribe } from "../util/listeners.js";
import type { Logger } from "../util/logger.js";
import type { Timers } from "../util/timers.js";
import type { WsHub } from "../ws/hub.js";
import { z } from "zod";
import { JiraReader } from "./jiraReader.js";
import { loadJiraSettings } from "./jiraSettings.js";

/** Bus event làm hàng đợi ticket thay đổi → đọc lại ngay (mục 5.4). */
const REFRESH_TRIGGERS = new Set(["ticket.created", "task.completed", "task.failed"]);

export interface JiraModule {
  reader: JiraReader;
  start(): void;
  close(): void;
}

export function createJiraModule(deps: {
  config: BridgeConfig;
  eventLog: EventLog;
  hub: WsHub;
  status: StatusService;
  timers: Timers;
  log: Logger;
}): JiraModule {
  const { config, eventLog, hub, status, timers, log } = deps;
  const reader = new JiraReader({
    settings: loadJiraSettings(config.jira_env_file),
    projects: config.projects,
    agentLabel: config.agent_label,
    pollMs: config.jira_poll_seconds * 1000,
    timers,
    log,
  });
  const unsubscribers: Unsubscribe[] = [
    reader.onTicketsChanged((tickets) => hub.broadcast("tickets.updated", { tickets })),
    reader.onStatusChanged(() => status.notifyChanged()),
    status.registerContributor(() => ({ jira: reader.status() })),
    hub.registerSnapshotContributor(() => ({ tickets: reader.tickets() })),
  ];
  let started = false;
  hub.registerHandler("tickets.refresh", z.object({}).strict(), async () => {
    if (!reader.configured()) return { refreshed: false, jira: reader.status() };
    await reader.refresh();
    return { refreshed: true, jira: reader.status(), count: reader.tickets().length };
  });
  return {
    reader,
    start() {
      if (started) return;
      started = true;
      unsubscribers.push(
        eventLog.onBusEvent((e) => {
          if (REFRESH_TRIGGERS.has(e.type)) void reader.refresh();
        }),
      );
      reader.start();
    },
    close() {
      reader.stop();
      for (const off of unsubscribers) off();
    },
  };
}
