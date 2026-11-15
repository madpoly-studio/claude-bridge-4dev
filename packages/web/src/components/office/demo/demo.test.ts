import { describe, expect, it } from "vitest";
import { isTerminalTaskState } from "@claude-bridge/protocol";
import { createDemoState } from "../../../demo/fixtures";
import { reducer } from "../../../state/reducer";
import { orchestratorSession } from "../../../state/selectors";
import type { Action, AppState } from "../../../state/types";
import { detectTransitions, INITIAL_FX } from "../model/effects";
import { OFFICE_LAYOUT } from "../model/layout";
import { buildWorkersScene, deriveOrchestratorScene, derivePlannerScene } from "../model/scene-state";
import { DIRECTOR_BEATS, directorStep, fxBurst } from "./director";
import { parseScenario, scenarioActions } from "./scenarios";

const NOW = Date.parse("2026-11-11T10:00:00Z");
const apply = (state: AppState, actions: Action[]): AppState => actions.reduce(reducer, state);
const base = () => createDemoState(NOW);

describe("parseScenario", () => {
  it("mặc định là live; giá trị lạ cũng về live", () => {
    expect(parseScenario("")).toBe("live");
    expect(parseScenario("?scenario=nope")).toBe("live");
    expect(parseScenario("?demo=1&scenario=crowd")).toBe("crowd");
    expect(parseScenario("?scenario=disconnected")).toBe("disconnected");
    expect(parseScenario("?scenario=planner-busy")).toBe("planner-busy");
  });
});

describe("scenarioActions", () => {
  it("still / live / fx không đổi fixture gốc", () => {
    for (const name of ["still", "live", "fx"] as const) expect(scenarioActions(name, base(), NOW)).toEqual([]);
  });

  it("crowd: 18 worker đủ trạng thái, có worker không có bàn, không ai biến mất khỏi cảnh", () => {
    const state = apply(base(), scenarioActions("crowd", base(), NOW));
    const workers = Object.values(state.workers);
    expect(workers).toHaveLength(18);
    expect(new Set(workers.map((w) => w.state))).toEqual(new Set(["busy", "idle", "offline"]));
    const phases = new Set(Object.values(state.tasks).filter((t) => t.state === "running").map((t) => t.phase));
    for (const p of ["understanding", "implementing", "testing", "pushing", "mr_created"]) expect(phases.has(p as never)).toBe(true);
    expect(Object.values(state.tasks).some((t) => t.state === "assigned")).toBe(true);

    const scene = buildWorkersScene({ workers: state.workers, tasks: state.tasks, fx: INITIAL_FX, rateLimited: false }, OFFICE_LAYOUT);
    // Tràn thật: mọi bàn đều có người, hai worker bận cuối vào chip "+N".
    expect(scene.actors.filter((a) => a.zone === "desk")).toHaveLength(OFFICE_LAYOUT.desks.length);
    expect(scene.overflow.desk).toEqual(["w-sh-17", "w-sh-18"]);
    const hidden = scene.overflow.desk.length + scene.overflow.relax.length + scene.overflow.pod.length;
    expect(scene.actors.length + hidden).toBe(18);
    expect(state.status!.running).toBeLessThanOrEqual(state.status!.max_concurrency);
  });

  it("paused / ratelimit / dead / disconnected đặt đúng cờ", () => {
    expect(apply(base(), scenarioActions("paused", base(), NOW)).status!.dispatch_paused).toBe(true);
    const limited = apply(base(), scenarioActions("ratelimit", base(), NOW));
    expect(Date.parse(limited.status!.rate_limited_until!)).toBeGreaterThan(NOW);
    expect(Object.values(limited.workers).filter((w) => w.state === "idle").length).toBeGreaterThanOrEqual(3);
    expect(apply(base(), scenarioActions("dead", base(), NOW)).status!.orchestrator).toBe("dead");
    expect(apply(base(), scenarioActions("disconnected", base(), NOW)).connection.phase).toBe("reconnecting");
  });
});

describe("scenarioActions cho agent", () => {
  const scenes = (state: AppState) => ({
    planner: derivePlannerScene(state.sessions, state.plannerSessionId, state.permissions),
    orchestrator: deriveOrchestratorScene(orchestratorSession(state), state.status?.orchestrator ?? null),
  });

  it("still: planner đang chờ duyệt nên ở chỗ làm việc, orchestrator rảnh ở góc home", () => {
    const { planner, orchestrator } = scenes(base());
    expect(planner).toMatchObject({ anim: "alert", spot: "work" });
    expect(orchestrator).toMatchObject({ anim: "idle", spot: "home" });
  });

  it("agents-home: không còn bản nháp chờ duyệt, cả hai rảnh ở góc home", () => {
    const state = apply(base(), scenarioActions("agents-home", base(), NOW));
    expect(Object.keys(state.permissions)).toHaveLength(0);
    expect(scenes(state).planner).toMatchObject({ anim: "idle", spot: "home" });
    expect(scenes(state).orchestrator).toMatchObject({ anim: "idle", spot: "home" });
  });

  it("planner-busy / orchestrator-busy: đúng một agent lên chỗ làm việc", () => {
    const p = scenes(apply(base(), scenarioActions("planner-busy", base(), NOW)));
    expect(p.planner).toMatchObject({ anim: "processing", spot: "work" });
    expect(p.orchestrator.spot).toBe("home");
    const o = scenes(apply(base(), scenarioActions("orchestrator-busy", base(), NOW)));
    expect(o.orchestrator).toMatchObject({ anim: "processing", spot: "work" });
    expect(o.planner).toMatchObject({ anim: "idle", spot: "home" });
  });

  it("dead: orchestrator đứng ở góc home với trạng thái alert", () => {
    const state = apply(base(), scenarioActions("dead", base(), NOW));
    expect(scenes(state).orchestrator).toMatchObject({ anim: "alert", spot: "home" });
  });
});

describe("directorStep", () => {
  it("tất định theo (state, tick, now)", () => {
    const strip = (actions: Action[]) => actions.map((a) => ("payload" in a ? { type: a.type, payload: a.payload } : a));
    expect(strip(directorStep(base(), 0, NOW))).toEqual(strip(directorStep(base(), 0, NOW)));
  });

  it("nhịp đầu: task assigned của w-sh-05 chuyển sang running", () => {
    const state = apply(base(), directorStep(base(), 0, NOW));
    expect(state.tasks["t-89"]!.state).toBe("running");
    expect(state.events.at(-1)!.type).toBe("task.started");
    expect(state.lastSeq).toBe(base().lastSeq + 1);
  });

  it("chạy 3 vòng: đi qua assigned, running, progress có message, completed, failed, offline rồi quay lại; seq luôn tăng", () => {
    let state = base();
    const startSeq = state.lastSeq;
    const seen = { completed: 0, failed: 0, assigned: 0, progress: 0, offline: 0, back: 0 };
    for (let tick = 0; tick < DIRECTOR_BEATS.length * 3; tick++) {
      const next = apply(state, directorStep(state, tick, NOW + tick * 2_500));
      for (const t of detectTransitions(state.tasks, next.tasks)) {
        if (t.to === "completed") seen.completed += 1;
        if (t.to === "failed") seen.failed += 1;
      }
      for (const ev of next.events.slice(state.events.length)) {
        if (ev.type === "task.assigned") seen.assigned += 1;
        if (ev.type === "worker.offline") seen.offline += 1;
        if (ev.type === "worker.registered") seen.back += 1;
        if (ev.type === "task.progress") {
          seen.progress += 1;
          expect(typeof (ev.payload as { message?: unknown }).message).toBe("string");
        }
      }
      state = next;
      // Bất biến: worker busy luôn có task sống; không worker nào có hai task sống.
      for (const w of Object.values(state.workers)) {
        const alive = Object.values(state.tasks).filter((t) => t.worker_id === w.worker_id && !isTerminalTaskState(t.state));
        expect(alive.length).toBeLessThanOrEqual(1);
        if (w.state === "busy") expect(alive).toHaveLength(1);
      }
      const runningTasks = Object.values(state.tasks).filter((t) => t.state === "running").length;
      // Nhịp không đụng task nào thì status giữ nguyên; từ nhịp đầu trở đi hai số luôn khớp.
      expect(state.status!.running).toBe(runningTasks);
      expect(state.status!.running).toBeLessThanOrEqual(state.status!.max_concurrency);
    }
    expect(seen.completed).toBeGreaterThan(0);
    expect(seen.failed).toBeGreaterThan(0);
    expect(seen.assigned).toBeGreaterThan(0);
    expect(seen.progress).toBeGreaterThan(0);
    expect(seen.offline).toBeGreaterThan(0);
    expect(seen.back).toBeGreaterThan(0);
    expect(state.lastSeq).toBeGreaterThan(startSeq);
    const seqs = state.events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("worker không tồn tại: không làm gì", () => {
    expect(directorStep({ ...base(), workers: {} }, 0, NOW)).toEqual([]);
  });
});

describe("fxBurst", () => {
  it("một task lỗi, một task hoàn thành và một progress có message trong cùng một loạt", () => {
    const before = base();
    const after = apply(before, fxBurst(before, NOW));
    const kinds = detectTransitions(before.tasks, after.tasks).map((t) => t.to).sort();
    expect(kinds).toEqual(["completed", "failed"]);
    const fresh = after.events.slice(before.events.length);
    expect(fresh.map((e) => e.type)).toEqual(["task.failed", "task.completed", "task.started", "task.progress"]);
    expect(after.tasks["t-89"]).toMatchObject({ state: "running", phase: "understanding" });
  });
});
