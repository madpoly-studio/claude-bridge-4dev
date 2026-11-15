// Trạng thái hệ thống thể hiện trong cảnh: biển báo, số trên bảng kanban, đồng hồ tải của tủ server. Thuần.
import type { SystemStatus } from "@claude-bridge/protocol";
import type { TicketGroups } from "../../../state/selectors";
import type { ConnectionPhase } from "../../../ws/client";
import { MAX_RACK_LEDS } from "../constants";

export interface SceneSignals {
  paused: boolean;
  rateLimitedUntil: string | null;
  disconnected: boolean;
}

export function deriveSignals(status: SystemStatus | null, phase: ConnectionPhase, rateLimited: boolean): SceneSignals {
  return {
    paused: status?.dispatch_paused ?? false,
    rateLimitedUntil: rateLimited ? (status?.rate_limited_until ?? null) : null,
    disconnected: phase === "reconnecting",
  };
}

export interface KanbanCounts {
  waiting: number;
  inProgress: number;
  review: number;
  failed: number;
}

/** review hiển thị = review thật trừ số note còn đang bay (không âm): số tăng đúng lúc note chạm bảng. */
export function kanbanCounts(groups: TicketGroups, notesInFlight: number): KanbanCounts {
  return {
    waiting: groups.waiting.length,
    inProgress: groups.inProgress.length,
    review: Math.max(0, groups.review.length - Math.max(0, notesInFlight)),
    failed: groups.failed.length,
  };
}

export interface RackGauge {
  lit: number;
  total: number;
  label: string;
}

export function rackGauge(status: SystemStatus | null): RackGauge {
  if (!status) return { lit: 0, total: 0, label: "Đang chạy —" };
  const total = Math.max(0, Math.min(MAX_RACK_LEDS, Math.floor(status.max_concurrency)));
  const lit = Math.max(0, Math.min(total, Math.floor(status.running)));
  return { lit, total, label: `Đang chạy ${status.running} / ${status.max_concurrency}` };
}
