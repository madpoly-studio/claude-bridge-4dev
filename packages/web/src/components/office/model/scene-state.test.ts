import { describe, expect, it } from "vitest";
import type { Session, Task, Worker } from "@claude-bridge/protocol";
import { makePermission, makeTask, makeWorker } from "../../../__tests__/helpers";
import { INITIAL_FX } from "./effects";
import type { SceneFxState, WorkerFx } from "./effects";
import { OFFICE_LAYOUT } from "./layout";
import {
  buildWorkersScene,
  deriveOrchestratorScene,
  derivePlannerScene,
  deriveWorkerScene,
  resolveTask,
  sceneWorkerEqual,
  SCENE_LABEL,
} from "./scene-state";
import { skinOf } from "./skin";

const NO_LIMIT = { rateLimited: false };
const byId = <T,>(items: T[], key: (t: T) => string): Record<string, T> => Object.fromEntries(items.map((t) => [key(t), t]));
const tasksOf = (...tasks: Task[]) => byId(tasks, (t) => t.task_id);
const workersOf = (...workers: Worker[]) => byId(workers, (w) => w.worker_id);

function session(p: Partial<Session> & Pick<Session, "session_id" | "role">): Session {
  return {
    claude_session_id: null,
    project_key: "SH",
    repo: null,
    title: null,
    state: "active",
    busy: false,
    created_at: "2026-11-11T10:00:00Z",
    last_active_at: "2026-11-11T10:00:00Z",
    ...p,
  };
}

describe("resolveTask", () => {
  const worker = makeWorker({ worker_id: "w-1", state: "busy", current_task_id: "t-1" });

  it("lấy current_task_id khi task chưa terminal", () => {
    const tasks = tasksOf(makeTask({ task_id: "t-1", ticket_key: "SH-1" }));
    expect(resolveTask(worker, tasks)?.task_id).toBe("t-1");
  });

  it("current_task_id đã terminal hoặc thiếu: quét task chưa terminal mới nhất của worker", () => {
    const tasks = tasksOf(
      makeTask({ task_id: "t-1", ticket_key: "SH-1", state: "completed" }),
      makeTask({ task_id: "t-2", ticket_key: "SH-2", state: "running", assigned_at: "2026-11-11T10:05:00Z" }),
      makeTask({ task_id: "t-3", ticket_key: "SH-3", state: "assigned", assigned_at: "2026-11-11T10:09:00Z" }),
      makeTask({ task_id: "t-4", ticket_key: "SH-4", state: "running", worker_id: "w-2", assigned_at: "2026-11-11T10:30:00Z" }),
    );
    expect(resolveTask(worker, tasks)?.task_id).toBe("t-3");
    expect(resolveTask(makeWorker({ worker_id: "w-1" }), tasks)?.task_id).toBe("t-3");
  });

  it("không còn task sống: null", () => {
    expect(resolveTask(worker, tasksOf(makeTask({ task_id: "t-1", ticket_key: "SH-1", state: "failed" })))).toBeNull();
    expect(resolveTask(worker, {})).toBeNull();
  });
});

describe("deriveWorkerScene (bảng ánh xạ)", () => {
  const idle = makeWorker({ worker_id: "w-1", state: "idle" });
  const busy = makeWorker({ worker_id: "w-1", state: "busy", current_task_id: "t-1" });
  const offline = makeWorker({ worker_id: "w-1", state: "offline" });
  const running = makeTask({ task_id: "t-1", ticket_key: "SH-1", state: "running", phase: "testing" });

  it("idle → khu Relax, animation idle, nhãn IDLE", () => {
    expect(deriveWorkerScene(idle, null, undefined, NO_LIMIT)).toMatchObject({
      zone: "relax",
      anim: "idle",
      stateLabel: "IDLE",
      detail: null,
      phaseIndex: null,
      taskId: null,
      screen: "off",
    });
  });

  it("idle khi rate limit → dòng phụ nghỉ cà phê", () => {
    expect(deriveWorkerScene(idle, null, undefined, { rateLimited: true }).detail).toBe(SCENE_LABEL.coffeeBreak);
  });

  it("busy + task running → ở bàn, work, phase và màn hình theo task", () => {
    expect(deriveWorkerScene(busy, running, undefined, NO_LIMIT)).toMatchObject({
      zone: "desk",
      anim: "work",
      stateLabel: "BUSY",
      detail: "SH-1",
      phaseIndex: 2,
      taskId: "t-1",
      screen: "testing",
    });
  });

  it("task running chưa báo phase → phaseIndex -1, màn hình waiting", () => {
    const intent = deriveWorkerScene(busy, { ...running, phase: null }, undefined, NO_LIMIT);
    expect(intent.phaseIndex).toBe(-1);
    expect(intent.screen).toBe("waiting");
  });

  it("task assigned → ở bàn, đứng idle, nhãn CHỜ RUNNER", () => {
    const assigned = makeTask({ task_id: "t-1", ticket_key: "SH-1", state: "assigned" });
    expect(deriveWorkerScene(busy, assigned, undefined, NO_LIMIT)).toMatchObject({
      zone: "desk",
      anim: "idle",
      stateLabel: SCENE_LABEL.waitingRunner,
      detail: "SH-1",
      taskId: "t-1",
      screen: "waiting",
    });
  });

  it("offline → pod, sleep, kể cả khi còn task treo", () => {
    expect(deriveWorkerScene(offline, running, undefined, NO_LIMIT)).toMatchObject({ zone: "pod", anim: "sleep", stateLabel: "OFFLINE", taskId: null });
  });

  it("lệch pha: worker idle nhưng task chưa terminal → vẫn ở bàn", () => {
    expect(deriveWorkerScene(idle, running, undefined, NO_LIMIT)).toMatchObject({ zone: "desk", anim: "work", taskId: "t-1" });
  });

  it("lệch pha: worker busy nhưng không tìm ra task → ở bàn, không có phase", () => {
    expect(deriveWorkerScene(busy, null, undefined, NO_LIMIT)).toMatchObject({
      zone: "desk",
      anim: "work",
      stateLabel: "BUSY",
      detail: null,
      phaseIndex: null,
      taskId: null,
      screen: "waiting",
    });
  });

  it("vừa completed → happy ở bàn, nhãn XONG, thắng trạng thái idle", () => {
    const fx: WorkerFx = { pose: { id: 7, kind: "happy", detail: "SH-1", taskId: "t-1", until: 99 }, bubble: null };
    expect(deriveWorkerScene(idle, null, fx, NO_LIMIT)).toMatchObject({
      zone: "desk",
      anim: "happy",
      animKey: 7,
      stateLabel: SCENE_LABEL.done,
      detail: "SH-1",
      taskId: "t-1",
      screen: "mr_created",
    });
  });

  it("vừa failed → error ở bàn, nhãn LỖI kèm fail_category, thắng cả offline", () => {
    const fx: WorkerFx = { pose: { id: 9, kind: "error", detail: "build_failed", taskId: "t-1", until: 99 }, bubble: null };
    expect(deriveWorkerScene(offline, null, fx, NO_LIMIT)).toMatchObject({
      zone: "desk",
      anim: "error",
      animKey: 9,
      stateLabel: SCENE_LABEL.failed,
      detail: "build_failed",
      screen: "off",
    });
  });
});

describe("buildWorkersScene", () => {
  const layout = OFFICE_LAYOUT;

  it("worker trong 10 chỉ số đầu ngồi bàn theo chỉ số trong sortedWorkers, không phụ thuộc worker khác đang ở đâu", () => {
    const workers = workersOf(
      makeWorker({ worker_id: "w-2", state: "busy", current_task_id: "t-2" }),
      makeWorker({ worker_id: "w-1", state: "idle" }),
      makeWorker({ worker_id: "w-10", state: "busy", current_task_id: "t-10" }),
    );
    const tasks = tasksOf(makeTask({ task_id: "t-2", ticket_key: "SH-2", worker_id: "w-2" }), makeTask({ task_id: "t-10", ticket_key: "SH-10", worker_id: "w-10" }));
    const scene = buildWorkersScene({ workers, tasks, fx: INITIAL_FX, rateLimited: false }, layout);
    const of = (id: string) => scene.actors.find((a) => a.id === id)!;
    // Sắp theo số: w-1, w-2, w-10 → chỉ số 0, 1, 2.
    expect(of("w-2").slotId).toBe(layout.desks[1]!.id);
    expect(of("w-10").slotId).toBe(layout.desks[2]!.id);
    expect(of("w-1").zone).toBe("relax");
    expect(of("w-2")).toMatchObject({ x: layout.desks[1]!.anchor.x, y: layout.desks[1]!.anchor.y, skin: skinOf("w-2") });
    expect(scene.screens[layout.desks[1]!.id]).toBe("waiting");
    expect(scene.screens[layout.desks[0]!.id]).toBe("off");
  });

  it("aria-label có tên, trạng thái, ticket, phase và hành động khi bấm", () => {
    const workers = workersOf(makeWorker({ worker_id: "w-1", state: "busy", current_task_id: "t-1" }), makeWorker({ worker_id: "w-2", state: "offline" }));
    const tasks = tasksOf(makeTask({ task_id: "t-1", ticket_key: "SH-1", phase: "implementing" }));
    const scene = buildWorkersScene({ workers, tasks, fx: INITIAL_FX, rateLimited: false }, layout);
    expect(scene.actors[0]!.ariaLabel).toBe("w-1, BUSY, SH-1, phase 2/5: implementing. Mở chi tiết task");
    expect(scene.actors[1]!.ariaLabel).toBe("w-2, OFFLINE. Xem thông tin worker");
  });

  it("nhiều worker hơn số chỗ: không ai biến mất, phần dư vào overflow", () => {
    const list: Worker[] = [];
    const tasks: Task[] = [];
    for (let i = 1; i <= 14; i++) {
      const id = `w-${String(i).padStart(2, "0")}`;
      list.push(makeWorker({ worker_id: id, state: "busy", current_task_id: `t-${i}` }));
      tasks.push(makeTask({ task_id: `t-${i}`, ticket_key: `SH-${i}`, worker_id: id }));
    }
    for (let i = 15; i <= 20; i++) list.push(makeWorker({ worker_id: `w-${i}`, state: "offline" }));
    for (let i = 21; i <= 32; i++) list.push(makeWorker({ worker_id: `w-${i}`, state: "idle" }));
    const scene = buildWorkersScene({ workers: workersOf(...list), tasks: tasksOf(...tasks), fx: INITIAL_FX, rateLimited: false }, layout);

    expect(scene.overflow.desk).toEqual(["w-11", "w-12", "w-13", "w-14"]);
    expect(scene.overflow.pod).toHaveLength(6 - layout.pods.length);
    expect(scene.overflow.relax).toHaveLength(12 - layout.relax.length);
    const shown = scene.actors.length + scene.overflow.desk.length + scene.overflow.pod.length + scene.overflow.relax.length;
    expect(shown).toBe(list.length);
    // Không hai robot nào chung một slot.
    expect(new Set(scene.actors.map((a) => a.slotId)).size).toBe(scene.actors.length);
  });

  /** `total` worker w-01..w-NN, chỉ các số trong `busy` đang chạy task. */
  function crowd(total: number, busy: number[]) {
    const list: Worker[] = [];
    const tasks: Task[] = [];
    for (let i = 1; i <= total; i++) {
      const id = `w-${String(i).padStart(2, "0")}`;
      if (busy.includes(i)) {
        list.push(makeWorker({ worker_id: id, state: "busy", current_task_id: `t-${i}` }));
        tasks.push(makeTask({ task_id: `t-${i}`, ticket_key: `SH-${i}`, worker_id: id }));
      } else {
        list.push(makeWorker({ worker_id: id, state: "idle" }));
      }
    }
    return { workers: workersOf(...list), tasks: tasksOf(...tasks) };
  }

  it("worker thứ 11 trở đi đang bận vẫn có bàn khi còn bàn trống; chip +N chỉ khi hết bàn", () => {
    const deskIds = layout.desks.map((d) => d.id);
    // 14 worker, chỉ w-03, w-12, w-14 bận: 3 người cho 10 bàn.
    const few = buildWorkersScene({ ...crowd(14, [3, 12, 14]), fx: INITIAL_FX, rateLimited: false }, layout);
    const of = (id: string) => few.actors.find((a) => a.id === id)!;
    expect(few.overflow.desk).toEqual([]);
    expect(of("w-03").slotId).toBe(deskIds[2]);
    expect(of("w-12")).toMatchObject({ zone: "desk", slotId: deskIds[0], x: layout.desks[0]!.anchor.x, y: layout.desks[0]!.anchor.y });
    expect(of("w-14")).toMatchObject({ zone: "desk", slotId: deskIds[1] });
    expect(few.screens[deskIds[0]!]).toBe("waiting");
    expect(Object.fromEntries(few.desks)).toEqual({ "w-03": deskIds[2], "w-12": deskIds[0], "w-14": deskIds[1] });

    // 9 bàn có người + w-12, w-14: chỉ còn 1 bàn trống, w-14 mới phải vào chip.
    const full = buildWorkersScene({ ...crowd(14, [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 14]), fx: INITIAL_FX, rateLimited: false }, layout);
    expect(full.actors.find((a) => a.id === "w-12")!.slotId).toBe(deskIds[9]);
    expect(full.overflow.desk).toEqual(["w-14"]);
    expect(new Set(full.actors.map((a) => a.slotId)).size).toBe(full.actors.length);
  });

  it("worker còn bận thì không đổi bàn giữa các lượt dựng cảnh, kể cả khi chủ bàn theo chỉ số bận sau hoặc bàn khác trống ra", () => {
    const deskIds = layout.desks.map((d) => d.id);
    const build = (busy: number[], prevDesks?: ReadonlyMap<string, string>) =>
      buildWorkersScene({ ...crowd(14, busy), fx: INITIAL_FX, rateLimited: false, prevDesks }, layout);
    const deskOf = (scene: ReturnType<typeof build>, id: string) => scene.actors.find((a) => a.id === id)?.slotId;

    const first = build([2, 12]);
    expect(deskOf(first, "w-12")).toBe(deskIds[0]);

    // w-01 (bàn theo chỉ số là bàn w-12 đang ngồi) bắt đầu bận: w-12 giữ bàn, w-01 lấy bàn trống đầu tiên.
    const second = build([1, 2, 12], first.desks);
    expect(deskOf(second, "w-12")).toBe(deskIds[0]);
    expect(deskOf(second, "w-02")).toBe(deskIds[1]);
    expect(deskOf(second, "w-01")).toBe(deskIds[2]);
    expect(second.overflow.desk).toEqual([]);

    // w-02 xong việc, bàn của nó trống: không ai nhảy sang.
    const third = build([1, 12], second.desks);
    expect(deskOf(third, "w-12")).toBe(deskIds[0]);
    expect(deskOf(third, "w-01")).toBe(deskIds[2]);
    expect(third.actors.find((a) => a.id === "w-02")!.zone).toBe("relax");

    // Dựng lại với chính kết quả vừa có (StrictMode chạy useMemo hai lần) cho ra cùng phép gán.
    expect(Object.fromEntries(build([1, 12], third.desks).desks)).toEqual(Object.fromEntries(third.desks));

    // Worker đang ăn mừng (pose happy) sau khi xong task vẫn đứng ở bàn nó vừa ngồi.
    const happy: SceneFxState = { byWorker: { "w-12": { pose: { id: 7, kind: "happy", detail: "SH-12", taskId: "t-12", until: 9 }, bubble: null } }, notes: [], nextId: 8 };
    const celebrating = buildWorkersScene({ ...crowd(14, [1]), fx: happy, rateLimited: false, prevDesks: third.desks }, layout);
    expect(celebrating.actors.find((a) => a.id === "w-12")).toMatchObject({ zone: "desk", slotId: deskIds[0], anim: "happy" });
  });

  it("rate limit: robot rảnh dồn ra quầy cà phê (plaza) trước, robot đang làm vẫn ở bàn", () => {
    const workers = workersOf(
      makeWorker({ worker_id: "w-1", state: "busy", current_task_id: "t-1" }),
      makeWorker({ worker_id: "w-2", state: "idle" }),
      makeWorker({ worker_id: "w-3", state: "idle" }),
    );
    const tasks = tasksOf(makeTask({ task_id: "t-1", ticket_key: "SH-1" }));
    const plaza = new Set(layout.relax.filter((s) => s.spot === "plaza").map((s) => s.id));
    const normal = buildWorkersScene({ workers, tasks, fx: INITIAL_FX, rateLimited: false }, layout);
    const limited = buildWorkersScene({ workers, tasks, fx: INITIAL_FX, rateLimited: true }, layout);
    expect(normal.actors.filter((a) => a.zone === "relax").every((a) => !plaza.has(a.slotId))).toBe(true);
    expect(limited.actors.filter((a) => a.zone === "relax").every((a) => plaza.has(a.slotId))).toBe(true);
    expect(limited.actors.find((a) => a.id === "w-2")!.detail).toBe(SCENE_LABEL.coffeeBreak);
    expect(limited.actors.find((a) => a.id === "w-1")!.zone).toBe("desk");
  });

  it("bong bóng lấy từ hiệu ứng tạm", () => {
    const workers = workersOf(makeWorker({ worker_id: "w-1", state: "busy", current_task_id: "t-1" }));
    const tasks = tasksOf(makeTask({ task_id: "t-1", ticket_key: "SH-1" }));
    const fx: SceneFxState = { byWorker: { "w-1": { pose: null, bubble: { id: 4, text: "Chạy test", tone: "progress", until: 9 } } }, notes: [], nextId: 5 };
    const actor = buildWorkersScene({ workers, tasks, fx, rateLimited: false }, layout).actors[0]!;
    expect(actor).toMatchObject({ bubbleId: 4, bubbleText: "Chạy test", bubbleTone: "progress" });
  });
});

describe("sceneWorkerEqual", () => {
  it("so sánh nông theo từng trường", () => {
    const workers = workersOf(makeWorker({ worker_id: "w-1" }));
    const a = buildWorkersScene({ workers, tasks: {}, fx: INITIAL_FX, rateLimited: false }, OFFICE_LAYOUT).actors[0]!;
    const b = buildWorkersScene({ workers, tasks: {}, fx: INITIAL_FX, rateLimited: false }, OFFICE_LAYOUT).actors[0]!;
    expect(a).not.toBe(b);
    expect(sceneWorkerEqual(a, b)).toBe(true);
    expect(sceneWorkerEqual(a, { ...b, stateLabel: "BUSY" })).toBe(false);
    expect(sceneWorkerEqual(a, { ...b, bubbleId: 3 })).toBe(false);
  });
});

describe("derivePlannerScene", () => {
  const sessions = byId(
    [session({ session_id: "p-1", role: "planner" }), session({ session_id: "p-2", role: "planner" }), session({ session_id: "o-1", role: "orchestrator" })],
    (s) => s.session_id,
  );

  it("không bận, không permission → idle", () => {
    expect(derivePlannerScene(sessions, "p-1", {})).toMatchObject({ anim: "idle", pendingCount: 0, jumpSessionId: null, statusLabel: "rảnh" });
  });

  it("chỗ đứng: rảnh hoặc chưa có phiên → góc home; đang trả lời hoặc đang chờ duyệt → chỗ làm việc", () => {
    const busy = { ...sessions, "p-1": { ...sessions["p-1"]!, busy: true } };
    const perm = { r1: makePermission({ request_id: "r1", session_id: "p-1" }) };
    const permElsewhere = { r1: makePermission({ request_id: "r1", session_id: "p-2" }) };
    expect(derivePlannerScene(sessions, "p-1", {}).spot).toBe("home");
    expect(derivePlannerScene(sessions, null, {}).spot).toBe("home");
    expect(derivePlannerScene({}, null, {}).spot).toBe("home");
    expect(derivePlannerScene(busy, "p-1", {})).toMatchObject({ anim: "processing", spot: "work" });
    // Phiên khác bận thì planner đang chọn vẫn rảnh.
    expect(derivePlannerScene(busy, "p-2", {}).spot).toBe("home");
    expect(derivePlannerScene(sessions, "p-1", perm)).toMatchObject({ anim: "alert", spot: "work" });
    expect(derivePlannerScene(busy, "p-1", perm)).toMatchObject({ anim: "alert", spot: "work" });
    expect(derivePlannerScene(sessions, "p-1", permElsewhere)).toMatchObject({ anim: "alert", spot: "work" });
    // Permission của orchestrator không giữ planner ở chỗ làm.
    expect(derivePlannerScene(sessions, "p-1", { r2: makePermission({ request_id: "r2", session_id: "o-1" }) }).spot).toBe("home");
  });

  it("bận theo phiên đang chọn", () => {
    const busy = { ...sessions, "p-2": { ...sessions["p-2"]!, busy: true } };
    expect(derivePlannerScene(busy, "p-2", {}).anim).toBe("processing");
    expect(derivePlannerScene(busy, "p-1", {}).anim).toBe("idle");
  });

  it("có permission chờ ở phiên đang chọn → alert, không cần nhảy phiên", () => {
    const perms = { r1: makePermission({ request_id: "r1", session_id: "p-1" }) };
    const scene = derivePlannerScene(sessions, "p-1", perms);
    expect(scene).toMatchObject({ anim: "alert", pendingCount: 1, jumpSessionId: null, statusLabel: "chờ duyệt (1)" });
    expect(scene.ariaLabel).toContain("1 bản nháp chờ duyệt");
  });

  it("permission ở phiên khác → alert và trỏ tới phiên có permission cũ nhất; bỏ qua permission của orchestrator", () => {
    const perms = {
      r1: makePermission({ request_id: "r1", session_id: "p-2", created_at: "2026-11-11T10:05:00Z" }),
      r2: makePermission({ request_id: "r2", session_id: "o-1", created_at: "2026-11-11T09:00:00Z" }),
    };
    expect(derivePlannerScene(sessions, "p-1", perms)).toMatchObject({ anim: "alert", pendingCount: 1, jumpSessionId: "p-2" });
    expect(derivePlannerScene(sessions, "p-1", { r2: perms.r2 })).toMatchObject({ anim: "idle", pendingCount: 0 });
  });

  it("alert thắng processing", () => {
    const busy = { ...sessions, "p-1": { ...sessions["p-1"]!, busy: true } };
    expect(derivePlannerScene(busy, "p-1", { r1: makePermission({ request_id: "r1", session_id: "p-1" }) }).anim).toBe("alert");
  });
});

describe("deriveOrchestratorScene", () => {
  const orch = session({ session_id: "o-1", role: "orchestrator" });

  it("theo health và busy, luôn có nhãn chữ", () => {
    expect(deriveOrchestratorScene(orch, "alive")).toMatchObject({ anim: "idle", statusLabel: "rảnh" });
    expect(deriveOrchestratorScene({ ...orch, busy: true }, "alive")).toMatchObject({ anim: "processing", statusLabel: "đang xử lý" });
    expect(deriveOrchestratorScene({ ...orch, busy: true }, "dead").anim).toBe("alert");
    expect(deriveOrchestratorScene(orch, "dead").statusLabel).toContain("dead");
    expect(deriveOrchestratorScene(orch, "restarting")).toMatchObject({ anim: "processing" });
    expect(deriveOrchestratorScene(orch, "stopped")).toMatchObject({ anim: "off" });
    expect(deriveOrchestratorScene(null, null).statusLabel).toBe("chưa có phiên");
  });

  it("chỗ đứng: chỉ lên chỗ làm việc khi còn sống và phiên đang bận; dead / stopped / restarting đứng ở góc home", () => {
    const busy = { ...orch, busy: true };
    expect(deriveOrchestratorScene(orch, "alive").spot).toBe("home");
    expect(deriveOrchestratorScene(null, null).spot).toBe("home");
    expect(deriveOrchestratorScene(busy, "alive")).toMatchObject({ anim: "processing", spot: "work" });
    // Chưa có system.status (health null) nhưng phiên đã bận: vẫn là đang làm việc.
    expect(deriveOrchestratorScene(busy, null).spot).toBe("work");
    expect(deriveOrchestratorScene(orch, "dead")).toMatchObject({ anim: "alert", spot: "home" });
    expect(deriveOrchestratorScene(busy, "dead")).toMatchObject({ anim: "alert", spot: "home" });
    expect(deriveOrchestratorScene(busy, "stopped")).toMatchObject({ anim: "off", spot: "home" });
    expect(deriveOrchestratorScene(busy, "restarting")).toMatchObject({ anim: "processing", spot: "home" });
  });
});
