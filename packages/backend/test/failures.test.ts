// Phase 1 exit criterion: 5 tình huống lỗi của mục 7.8, dùng runner giả và clock giả.
import { afterEach, describe, expect, it } from "vitest";
import { type TestContext, FakeRunner, busEventTypes, registerRunners, removeDir, startBridge } from "./helpers.js";

describe("failure handling (7.8)", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.bridge.close();
    removeDir(ctx.dir);
  });

  it("assigned > 60s without started → failed(runner_unresponsive), worker offline", async () => {
    ctx = await startBridge();
    const { bus, sweeper } = ctx.bridge;
    await registerRunners(ctx.bridge, "w-1");
    const { task_id } = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });

    ctx.clock.advanceSeconds(30);
    // Giữ worker còn sống bằng heartbeat để chỉ kiểm luật start-timeout.
    await new FakeRunner(ctx.bridge, "w-1").register(task_id);
    expect(sweeper.sweep().unresponsive).toEqual([]);

    ctx.clock.advanceSeconds(31);
    expect(sweeper.sweep().unresponsive).toEqual([task_id]);
    expect(bus.getTask(task_id)).toMatchObject({ state: "failed", fail_category: "runner_unresponsive" });
    expect(bus.listWorkers()[0]).toMatchObject({ state: "offline", current_task_id: null });
    const events = ctx.bridge.eventLog.readBusEventsSince(0);
    expect(events.find((e) => e.type === "task.failed")?.payload).toMatchObject({ category: "runner_unresponsive", attempt: 1 });
    expect(events.find((e) => e.type === "worker.offline")?.payload).toEqual({ reason: "runner_unresponsive" });
  });

  it("heartbeat lost 45s → worker offline, running task failed(runner_lost); runner comes back → worker.registered", async () => {
    ctx = await startBridge();
    const { bus, sweeper } = ctx.bridge;
    const [r1] = await registerRunners(ctx.bridge, "w-1");
    const { task_id } = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });
    await r1!.pickUp();
    await r1!.started(task_id);

    ctx.clock.advanceSeconds(40);
    expect((await r1!.heartbeat(task_id)).body).toEqual({ cancel: false });
    ctx.clock.advanceSeconds(44);
    expect(sweeper.sweep().lostWorkers).toEqual([]);
    ctx.clock.advanceSeconds(2);
    expect(sweeper.sweep().lostWorkers).toEqual(["w-1"]);

    expect(bus.getTask(task_id)).toMatchObject({ state: "failed", fail_category: "runner_lost" });
    expect(bus.listWorkers()[0]?.state).toBe("offline");
    expect(busEventTypes(ctx.bridge)).toEqual(
      expect.arrayContaining(["worker.offline", "task.failed"]),
    );

    // Runner sống lại: heartbeat nhận lệnh kill task cũ, worker quay về idle và được công bố lại.
    expect((await r1!.heartbeat(task_id)).body).toEqual({ cancel: true, task_id });
    expect(bus.listWorkers()[0]?.state).toBe("idle");
    expect(busEventTypes(ctx.bridge).filter((t) => t === "worker.registered")).toHaveLength(2);
  });

  it("TASK_TIMEOUT → runner kills and reports exited{timeout} → failed(timeout); bus backstop too", async () => {
    ctx = await startBridge({ config: { task_timeout_minutes: 60 } });
    const { bus, sweeper } = ctx.bridge;
    const [r1, r2] = await registerRunners(ctx.bridge, "w-1", "w-2");

    const a = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" }).task_id;
    const next = await r1!.pickUp();
    expect(next.timeout_seconds).toBe(3600);
    await r1!.started(a);
    await r1!.exited(a, { exit_code: null, reason: "timeout", usage: { output_tokens: 10 } });
    expect(bus.getTask(a)).toMatchObject({ state: "failed", fail_category: "timeout", usage: { output_tokens: 10 } });
    expect(bus.listWorkers().find((w) => w.worker_id === "w-1")?.state).toBe("idle");

    // Backstop: runner im lặng về timeout nhưng vẫn heartbeat.
    const b = bus.assignTask({ worker_id: "w-2", ticket_key: "SH-2" }).task_id;
    await r2!.pickUp();
    await r2!.started(b);
    for (let elapsed = 0; elapsed < 65 * 60; elapsed += 30) {
      ctx.clock.advanceSeconds(30);
      await r2!.heartbeat(b);
      sweeper.sweep();
    }
    expect(bus.getTask(b)?.state).toBe("running");
    ctx.clock.advanceSeconds(31);
    await r2!.heartbeat(b);
    expect(sweeper.sweep().timedOut).toEqual([b]);
    expect(bus.getTask(b)).toMatchObject({ state: "failed", fail_category: "timeout" });
    expect((await r2!.heartbeat(b)).body).toEqual({ cancel: true, task_id: b });
  });

  it("process exits without a terminal report → failed(no_terminal_report); other exit reasons map", async () => {
    ctx = await startBridge({ config: { max_concurrency: 4 } });
    const { bus } = ctx.bridge;
    const [r1, r2, r3, r4] = await registerRunners(ctx.bridge, "w-1", "w-2", "w-3", "w-4");

    const a = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" }).task_id;
    await r1!.pickUp();
    await r1!.started(a);
    bus.reportProgress(a, { phase: "implementing", message: "half way" });
    await r1!.exited(a, { exit_code: 137 });
    expect(bus.getTask(a)).toMatchObject({ state: "failed", fail_category: "no_terminal_report", phase: "implementing" });
    expect(bus.getTask(a)?.fail_reason).toContain("137");

    const b = bus.assignTask({ worker_id: "w-2", ticket_key: "SH-2" }).task_id;
    await r2!.pickUp();
    await r2!.exited(b, { exit_code: null, reason: "conflict", message: "worktree dirty" });
    expect(bus.getTask(b)).toMatchObject({ state: "failed", fail_category: "conflict", fail_reason: "worktree dirty" });

    const c = bus.assignTask({ worker_id: "w-3", ticket_key: "SH-3" }).task_id;
    await r3!.pickUp();
    await r3!.exited(c, { exit_code: null, reason: "spawn_error", message: "claude not found" });
    expect(bus.getTask(c)).toMatchObject({ state: "failed", fail_category: "other", fail_reason: "claude not found" });

    // Báo cáo kết thúc có trước khi exit → giữ nguyên completed, chỉ thêm usage.
    const d = bus.assignTask({ worker_id: "w-4", ticket_key: "SH-4" }).task_id;
    await r4!.pickUp();
    await r4!.started(d);
    bus.completeTask(d, { mr_url: "https://git.example/mr/4", branch: "feat/SH-4", summary: "ok" });
    await r4!.exited(d, { exit_code: 0, usage: { input_tokens: 5 } });
    expect(bus.getTask(d)).toMatchObject({ state: "completed", usage: { input_tokens: 5 } });
    expect(bus.listWorkers().every((w) => w.state === "idle")).toBe(true);
  });

  it("bus restart → state and tokens restored from SQLite; runners re-register and reconcile", async () => {
    ctx = await startBridge();
    const dir = ctx.dir;
    const [r1, r2, r3] = await registerRunners(ctx.bridge, "w-1", "w-2", "w-3");
    const running = ctx.bridge.bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" }).task_id;
    const delivered = await r1!.pickUp();
    await r1!.started(running);
    const lostOnRestart = ctx.bridge.bus.assignTask({ worker_id: "w-2", ticket_key: "SH-2" }).task_id;
    await r2!.pickUp();
    await r2!.started(lostOnRestart);
    ctx.bridge.bus.setDispatchPaused(true);
    const lastSeq = ctx.bridge.eventLog.lastSeq();
    await ctx.bridge.close();

    // Bus khởi động lại muộn 10 phút trên cùng file DB.
    ctx.clock.advanceSeconds(600);
    ctx = await startBridge({ dir, clock: ctx.clock });
    const { bus, sweeper } = ctx.bridge;
    expect(bus.getTask(running)?.state).toBe("running");
    expect(bus.isDispatchPaused()).toBe(true);
    expect(ctx.bridge.eventLog.lastSeq()).toBe(lastSeq);

    // Ân hạn sau restart: chưa coi runner là mất liên lạc ngay.
    expect(sweeper.sweep()).toEqual({ unresponsive: [], lostWorkers: [], timedOut: [] });

    // Task token cũ vẫn dùng được (chỉ lưu hash trong DB).
    expect(bus.resolveTaskToken(delivered.task_token)).toBe(running);

    // Runner token cũ vẫn hợp lệ cho heartbeat.
    const rebound1 = new FakeRunner(ctx.bridge, "w-1");
    rebound1.token = r1!.token;
    expect((await rebound1.heartbeat(running)).status).toBe(200);

    // Đối chiếu khi đăng ký lại.
    expect((await rebound1.register(running)).body.reconcile).toBe("continue");
    expect(bus.listWorkers().find((w) => w.worker_id === "w-1")).toMatchObject({ state: "busy", current_task_id: running });

    const rebound2 = new FakeRunner(ctx.bridge, "w-2");
    const reg2 = await rebound2.register(null);
    expect(reg2.body.reconcile).toBe("none");
    expect(bus.getTask(lostOnRestart)).toMatchObject({ state: "failed", fail_category: "runner_lost" });
    expect(reg2.body.worker.state).toBe("idle");

    const rebound3 = new FakeRunner(ctx.bridge, "w-3");
    expect((await rebound3.register("t-unknown")).body.reconcile).toBe("abort");

    // Worker không đăng ký lại sau ân hạn → offline.
    ctx.clock.advanceSeconds(46);
    await rebound1.heartbeat(running);
    await rebound2.heartbeat(null);
    expect(sweeper.sweep().lostWorkers).toEqual(["w-3"]);
    void r3;
  });
});
