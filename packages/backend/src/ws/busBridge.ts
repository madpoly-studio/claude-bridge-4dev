// Nối Task Bus / Event Log / Status vào WS hub và đăng ký các handler có sẵn của Phase 1.
import type { BusCore } from "../bus/busCore.js";
import type { TaskBus } from "../bus/taskBus.js";
import type { EventLog } from "../events/eventLog.js";
import type { StatusService } from "../status/statusService.js";
import { z } from "zod";
import { type WsHub, WsError } from "./hub.js";

const emptySchema = z.object({}).strict();
const taskOpenSchema = z.object({ task_id: z.string().min(1).max(128), since: z.number().int().min(0).optional() });

export interface BusBridgeDeps {
  hub: WsHub;
  core: BusCore;
  bus: TaskBus;
  eventLog: EventLog;
  status: StatusService;
}

export function connectBusToHub({ hub, core, bus, eventLog, status }: BusBridgeDeps): () => void {
  const unsubscribers = [
    eventLog.onBusEvent((event) => hub.broadcast("bus.event", event)),
    eventLog.onSessionEvent((record) => hub.routeSessionEvent(record)),
    core.onWorkerUpdated((worker) => hub.broadcast("worker.updated", worker)),
    core.onTaskUpdated((task) => hub.broadcast("task.updated", task)),
    status.onChanged((s) => hub.broadcast("system.status", s)),
  ];

  hub.registerHandler("dispatch.pause", emptySchema, () => ({ changed: bus.setDispatchPaused(true) }));
  hub.registerHandler("dispatch.resume", emptySchema, () => ({ changed: bus.setDispatchPaused(false) }));

  hub.registerHandler("task.open", taskOpenSchema, ({ client }, payload) => {
    const task = bus.getTask(payload.task_id);
    if (!task) throw new WsError("NOT_FOUND", `task ${payload.task_id} not found`);
    // Đọc lịch sử và đăng ký nhận live trong cùng một tick → không lọt / trùng event.
    const { events, truncated } = eventLog.readSessionHistory({ task_id: task.task_id, since: payload.since ?? 0 });
    client.openTask(task.task_id);
    client.send("session.history", {
      session_id: task.session_id,
      task_id: task.task_id,
      events,
      truncated,
      first_id: events[0]?.id ?? null,
    });
    return { task };
  });

  // Jira Reader (phase sau) thay handler này bằng registerHandler("tickets.refresh", ...).
  hub.registerHandler("tickets.refresh", emptySchema, () => ({ refreshed: false }));

  return () => {
    for (const off of unsubscribers) off();
  };
}
