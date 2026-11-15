// Bộ đạo diễn demo: mỗi nhịp nhìn state hiện tại rồi trả các action của bước kế. Thuần và tất định theo (state, tick, now).
// Mỗi bước tự kiểm điều kiện trên state, không đủ thì bỏ qua, nên mount lại giữa chừng vẫn chạy tiếp được.
import { TASK_PHASES, isTerminalTaskState } from "@claude-bridge/protocol";
import type { BusEventType, FailCategory, Task, TaskPhase, Worker } from "@claude-bridge/protocol";
import type { Action, AppState } from "../../../state/types";
import { demoMsg, demoTask, demoWorker } from "./scenarios";

type Beat = { kind: "advance" | "fail" | "toggle"; worker: string };

/** Một vòng 16 nhịp (≈ 40 s ở nhịp 2,5 s) rồi lặp. */
export const DIRECTOR_BEATS: readonly Beat[] = [
  { kind: "advance", worker: "w-sh-05" },
  { kind: "advance", worker: "w-sh-01" },
  { kind: "advance", worker: "w-sh-03" },
  { kind: "advance", worker: "w-sh-02" },
  { kind: "advance", worker: "w-sh-03" },
  { kind: "advance", worker: "w-sh-05" },
  { kind: "advance", worker: "w-sh-02" },
  { kind: "toggle", worker: "w-sh-04" },
  { kind: "advance", worker: "w-sh-02" },
  { kind: "advance", worker: "w-sh-03" },
  { kind: "advance", worker: "w-sh-01" },
  { kind: "fail", worker: "w-sh-03" },
  { kind: "advance", worker: "w-sh-02" },
  { kind: "advance", worker: "w-sh-05" },
  { kind: "toggle", worker: "w-sh-04" },
  { kind: "advance", worker: "w-sh-02" },
];

export const PROGRESS_TEXT: Record<TaskPhase, string> = {
  understanding: "Đọc ticket và code liên quan",
  implementing: "Đang sửa code",
  testing: "Chạy test",
  pushing: "Đẩy nhánh lên GitLab",
  mr_created: "Đã tạo merge request",
};

const DEMO_FAIL: FailCategory = "build_failed";
const DEMO_MR_BASE = "https://gitlab.example.com/game/sniper-hunting-client/-/merge_requests";
const FALLBACK_TICKET_BASE = 200;

export function activeTaskOf(state: AppState, workerId: string): Task | null {
  let best: Task | null = null;
  for (const t of Object.values(state.tasks)) {
    if (t.worker_id !== workerId || isTerminalTaskState(t.state)) continue;
    if (!best || t.assigned_at > best.assigned_at) best = t;
  }
  return best;
}

/** Ticket chưa có task đang sống và chưa xong; hết thì sinh key giả. */
function pickTicket(state: AppState, seq: number): string {
  const used = new Set(Object.values(state.tasks).filter((t) => !isTerminalTaskState(t.state) || t.state === "completed").map((t) => t.ticket_key));
  const free = state.tickets.find((t) => t.status_category !== "done" && !used.has(t.key));
  return free?.key ?? `SH-${FALLBACK_TICKET_BASE + seq}`;
}

/** Gom action của một loạt; seq của bus event tăng dần từ state.lastSeq như DemoBridgeService.pushBusEvent. */
class Script {
  readonly actions: Action[] = [];
  private seq: number;
  private touchedTasks = false;

  constructor(
    private readonly state: AppState,
    private readonly now: number,
  ) {
    this.seq = state.lastSeq;
  }

  private iso(): string {
    return new Date(this.now).toISOString();
  }

  private bus(type: BusEventType, workerId: string, task: Task | null, payload: Record<string, unknown> = {}): void {
    this.seq += 1;
    this.actions.push(
      demoMsg("bus.event", {
        seq: this.seq,
        ts: this.iso(),
        type,
        worker_id: workerId,
        task_id: task?.task_id ?? null,
        ticket_key: task?.ticket_key ?? null,
        payload,
      }),
    );
  }

  private setWorker(w: Worker, state: Worker["state"], taskId: string | null): void {
    const base = demoWorker(w.worker_id, state, taskId, this.now);
    this.actions.push(demoMsg("worker.updated", { ...base, repo: w.repo, worktree_path: w.worktree_path, host: w.host }));
  }

  assign(w: Worker): Task {
    const created = demoTask(
      { task_id: `demo-${this.seq + 1}`, ticket_key: pickTicket(this.state, this.seq + 1), worker_id: w.worker_id, state: "assigned", assigned_at: this.iso() },
      this.now,
    );
    this.actions.push(demoMsg("task.updated", created));
    this.setWorker(w, "busy", created.task_id);
    this.bus("task.assigned", w.worker_id, created);
    return created;
  }

  start(w: Worker, task: Task): Task {
    const started: Task = { ...task, state: "running", started_at: this.iso() };
    this.actions.push(demoMsg("task.updated", started));
    this.setWorker(w, "busy", task.task_id);
    this.bus("task.started", w.worker_id, started);
    this.touchedTasks = true;
    return started;
  }

  progress(w: Worker, task: Task, phase: TaskPhase): Task {
    const next: Task = { ...task, phase };
    this.actions.push(demoMsg("task.updated", next));
    this.bus("task.progress", w.worker_id, next, { phase, message: PROGRESS_TEXT[phase] });
    return next;
  }

  complete(w: Worker, task: Task): void {
    const mr = `${DEMO_MR_BASE}/${400 + (this.seq % 100)}`;
    const done: Task = { ...task, state: "completed", phase: "mr_created", mr_url: mr, ended_at: this.iso() };
    this.actions.push(demoMsg("task.updated", done));
    this.setWorker(w, "idle", null);
    this.bus("task.completed", w.worker_id, done, { mr_url: mr, branch: task.branch, summary: "" });
    this.touchedTasks = true;
  }

  failTask(w: Worker, task: Task): void {
    const failed: Task = { ...task, state: "failed", fail_category: DEMO_FAIL, fail_reason: "Demo: build lỗi ở bước kiểm tra", ended_at: this.iso() };
    this.actions.push(demoMsg("task.updated", failed));
    this.setWorker(w, "idle", null);
    this.bus("task.failed", w.worker_id, failed, { category: DEMO_FAIL, reason: "CS0246", attempt: task.attempt });
    this.touchedTasks = true;
  }

  /** Đẩy vòng đời của worker lên một bước: idle → assigned → running → phase kế → completed. */
  advance(w: Worker): void {
    if (w.state === "offline") return;
    const task = activeTaskOf(this.state, w.worker_id);
    if (!task) {
      this.assign(w);
      return;
    }
    if (task.state === "assigned") {
      this.start(w, task);
      return;
    }
    const next = TASK_PHASES[(task.phase ? TASK_PHASES.indexOf(task.phase) : -1) + 1];
    if (next) this.progress(w, task, next);
    else this.complete(w, task);
  }

  fail(w: Worker): void {
    const task = activeTaskOf(this.state, w.worker_id);
    if (task?.state === "running") this.failTask(w, task);
  }

  toggle(w: Worker): void {
    if (w.state === "busy" || activeTaskOf(this.state, w.worker_id)) return;
    if (w.state === "offline") {
      this.setWorker(w, "idle", null);
      this.bus("worker.registered", w.worker_id, null);
    } else {
      this.setWorker(w, "offline", null);
      this.bus("worker.offline", w.worker_id, null);
    }
  }

  finish(): Action[] {
    const status = this.state.status;
    if (!status || !this.touchedTasks) return this.actions;
    // Đếm lại từ task sau loạt này (fixture gốc để running lệch 1 so với số task đang chạy).
    const tasks = { ...this.state.tasks };
    for (const a of this.actions) if (a.type === "task.updated") tasks[a.payload.task_id] = a.payload;
    const running = Object.values(tasks).filter((t) => t.state === "running").length;
    // Demo không có bộ điều phối thật: nới max_concurrency để thanh "Đang chạy" không vượt trần.
    this.actions.push(demoMsg("system.status", { ...status, running, max_concurrency: Math.max(status.max_concurrency, running) }));
    return this.actions;
  }
}

/** Một nhịp của kịch bản sống. */
export function directorStep(state: AppState, tick: number, now: number): Action[] {
  const beat = DIRECTOR_BEATS[((tick % DIRECTOR_BEATS.length) + DIRECTOR_BEATS.length) % DIRECTOR_BEATS.length]!;
  const worker = state.workers[beat.worker];
  if (!worker) return [];
  const script = new Script(state, now);
  script[beat.kind](worker);
  return script.finish();
}

/**
 * Kịch bản `fx`: trong cùng một loạt, worker đang chạy đầu tiên lỗi, worker thứ hai hoàn thành,
 * và một worker đang chờ runner bắt đầu chạy kèm bong bóng progress. Dùng để chụp happy / error / note bay.
 */
export function fxBurst(state: AppState, now: number): Action[] {
  const script = new Script(state, now);
  const active = Object.values(state.workers)
    .sort((a, b) => a.worker_id.localeCompare(b.worker_id, undefined, { numeric: true }))
    .map((w) => ({ w, task: activeTaskOf(state, w.worker_id) }));
  const running = active.filter((x): x is { w: Worker; task: Task } => x.task?.state === "running");
  const waiting = active.find((x): x is { w: Worker; task: Task } => x.task?.state === "assigned");
  if (running[0]) script.failTask(running[0].w, running[0].task);
  if (running[1]) script.complete(running[1].w, running[1].task);
  if (waiting) script.progress(waiting.w, script.start(waiting.w, waiting.task), "understanding");
  return script.finish();
}
