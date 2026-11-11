// SystemStatus (mục 9, 10.2): bus sở hữu dispatch_paused / running / max_concurrency;
// các field khác (orchestrator, project_key, jira, seat_usage, rate_limited_until) do module khác góp.
import type { SystemStatus } from "@claude-bridge/protocol";
import type { BusCore } from "../bus/busCore.js";
import type { TaskBus } from "../bus/taskBus.js";
import { ListenerSet, type Unsubscribe } from "../util/listeners.js";

export type ContributedStatus = Partial<Omit<SystemStatus, "backend" | "dispatch_paused" | "running" | "max_concurrency">>;
/** Phải đồng bộ và rẻ (đọc từ bộ nhớ): được gọi mỗi lần dựng status. */
export type StatusContributor = () => ContributedStatus;

const DEFAULT_STATUS: ContributedStatus = { project_key: null, orchestrator: "stopped", jira: "unconfigured" };

export class StatusService {
  private readonly contributors = new Set<StatusContributor>();
  private readonly listeners = new ListenerSet<SystemStatus>("status");

  constructor(
    private readonly bus: TaskBus,
    core: BusCore,
  ) {
    core.onStatusChanged(() => this.notifyChanged());
  }

  /** Đóng góp field status; contributor đăng ký sau thắng nếu trùng field. */
  registerContributor(contributor: StatusContributor): Unsubscribe {
    this.contributors.add(contributor);
    return () => {
      this.contributors.delete(contributor);
    };
  }

  get(): SystemStatus {
    let merged: ContributedStatus = { ...DEFAULT_STATUS };
    for (const c of this.contributors) merged = { ...merged, ...c() };
    const bus = this.bus.status();
    return {
      project_key: merged.project_key ?? null,
      orchestrator: merged.orchestrator ?? "stopped",
      jira: merged.jira ?? "unconfigured",
      ...(merged.seat_usage !== undefined ? { seat_usage: merged.seat_usage } : {}),
      ...(merged.rate_limited_until !== undefined ? { rate_limited_until: merged.rate_limited_until } : {}),
      backend: "ok",
      dispatch_paused: bus.dispatch_paused,
      // Đếm assigned + running, khớp với cách bus áp max_concurrency.
      running: bus.active,
      max_concurrency: bus.max_concurrency,
    };
  }

  /** Module khác gọi khi field nó góp thay đổi → hub đẩy `system.status`. */
  notifyChanged(): void {
    this.listeners.emit(this.get());
  }

  onChanged(cb: (status: SystemStatus) => void): Unsubscribe {
    return this.listeners.add(cb);
  }
}
