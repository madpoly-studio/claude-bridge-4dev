import { RUNNER_PATHS, buildWorkerPrompt } from "@claude-bridge/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BusError } from "../src/bus/errors.js";
import { type TestContext, FakeRunner, busEventTypes, registerRunners, removeDir, startBridge } from "./helpers.js";

describe("runner HTTP API (7.5)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await startBridge();
  });
  afterEach(async () => {
    await ctx.bridge.close();
    removeDir(ctx.dir);
  });

  it("register is idempotent and only announces new / returning workers", async () => {
    const r = new FakeRunner(ctx.bridge, "w-1");
    const first = await r.register();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ reconcile: "none", heartbeat_seconds: 15, worker: { worker_id: "w-1", state: "idle" } });
    expect(first.body.worker).not.toHaveProperty("runner_token_hash");
    const oldToken = r.token;
    await r.register();
    expect(r.token).not.toBe(oldToken);
    expect(busEventTypes(ctx.bridge)).toEqual(["worker.registered"]);

    // Token cũ bị thay thế khi đăng ký lại.
    const stale = new FakeRunner(ctx.bridge, "w-1");
    stale.token = oldToken;
    expect((await stale.heartbeat(null)).status).toBe(401);
  });

  it("rejects bad bootstrap tokens, foreign runner tokens and invalid bodies", async () => {
    const r = new FakeRunner(ctx.bridge, "w-1");
    expect((await r.register(null, "wrong-bootstrap-token-000000")).status).toBe(401);
    const [r1, r2] = await registerRunners(ctx.bridge, "w-1", "w-2");
    const { task_id } = ctx.bridge.bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });

    // Runner token của w-2 không đụng được worker / task của w-1.
    const impostor = new FakeRunner(ctx.bridge, "w-1");
    impostor.token = r2!.token;
    expect((await impostor.heartbeat(null)).status).toBe(401);
    const res = await r2!.started(task_id);
    expect(res).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });

    const bad = await ctx.bridge.app.inject({
      method: "POST",
      url: RUNNER_PATHS.started(task_id),
      headers: { authorization: `Bearer ${r1!.token}` },
      payload: { session_id: 5 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });

    const missing = await r1!.started("t-nope");
    expect(missing).toMatchObject({ status: 404, body: { error: { code: "TASK_NOT_FOUND" } } });
  });

  it("long-poll returns 204 on timeout and wakes immediately on assign_task", async () => {
    const [r1] = await registerRunners(ctx.bridge, "w-1");
    const empty = await r1!.next(0);
    expect(empty.status).toBe(204);

    const started = Date.now();
    const pending = r1!.next(20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { task_id } = ctx.bridge.bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1", notes: "be careful" });
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      task: { task_id, ticket_key: "SH-1", state: "assigned", notes: "be careful" },
      mcp_url: `${ctx.bridge.baseUrl()}/mcp`,
      prompt: buildWorkerPrompt({ ticket_key: "SH-1", task_id, notes: "be careful" }),
      timeout_seconds: 3600,
    });
    expect(ctx.bridge.bus.resolveTaskToken(res.body!.task_token)).toBe(task_id);

    // Gọi lại next trước khi started → cùng task, cùng token.
    const again = await r1!.next(0);
    expect(again.body?.task_token).toBe(res.body!.task_token);
  });

  it("started → running; null session_id is filled from the init event; events are stored per task", async () => {
    const [r1] = await registerRunners(ctx.bridge, "w-1");
    const { task_id } = ctx.bridge.bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });
    await r1!.pickUp();
    expect((await r1!.started(task_id, null, 99)).status).toBe(200);
    expect(ctx.bridge.bus.getTask(task_id)).toMatchObject({ state: "running", session_id: null });

    const received: unknown[] = [];
    ctx.bridge.eventLog.onSessionEvent((r) => received.push(r));
    await r1!.events(task_id, [
      { type: "system", subtype: "init", session_id: "claude-abc" },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    ]);
    expect(ctx.bridge.bus.getTask(task_id)?.session_id).toBe("claude-abc");
    const stored = ctx.bridge.eventLog.readSessionEvents({ task_id });
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ session_id: "claude-abc", task_id, origin: "agent" });
    expect(received).toHaveLength(2);
    expect(busEventTypes(ctx.bridge)).toContain("task.started");
  });

  it("heartbeat returns cancel for a cancelled task until the runner reports exit", async () => {
    const [r1] = await registerRunners(ctx.bridge, "w-1");
    const { bus } = ctx.bridge;
    const { task_id } = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });
    await r1!.pickUp();
    await r1!.started(task_id);
    expect((await r1!.heartbeat(task_id)).body).toEqual({ cancel: false });

    const cancelled = bus.cancelTask({ task_id, reason: "ticket closed" });
    expect(cancelled).toMatchObject({ state: "cancelled", fail_reason: "ticket closed" });
    expect((await r1!.heartbeat(task_id)).body).toEqual({ cancel: true, task_id });

    await r1!.exited(task_id, { exit_code: null, reason: "cancelled" });
    expect(bus.getTask(task_id)?.state).toBe("cancelled");
    expect(bus.listWorkers()[0]).toMatchObject({ state: "idle", current_task_id: null });
    // Task lạ / thuộc worker khác cũng bị yêu cầu kill.
    expect((await r1!.heartbeat("t-unknown")).body).toEqual({ cancel: true, task_id: "t-unknown" });
    // Worker tự fail_task: không kill (process tự thoát).
    const second = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-2" }).task_id;
    await r1!.pickUp();
    await r1!.started(second);
    bus.failTask(second, { category: "blocked", reason: "needs SH-1" });
    expect((await r1!.heartbeat(second)).body).toEqual({ cancel: false });
  });

  it("started on a task cancelled before spawn → 409 TASK_NOT_ACTIVE", async () => {
    const [r1] = await registerRunners(ctx.bridge, "w-1");
    const { task_id } = ctx.bridge.bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });
    await r1!.pickUp();
    ctx.bridge.bus.cancelTask({ task_id, reason: "changed my mind" });
    expect(await r1!.started(task_id)).toMatchObject({ status: 409, body: { error: { code: "TASK_NOT_ACTIVE" } } });
  });

  it("runner contract: unknown worker → 404, terminal-task reports → 4xx / idempotent exited, never 5xx", async () => {
    const ghost = new FakeRunner(ctx.bridge, "w-ghost");
    ghost.token = "some-token-from-a-previous-db";
    expect(await ghost.heartbeat(null)).toMatchObject({ status: 404, body: { error: { code: "WORKER_NOT_FOUND" } } });
    expect(await ghost.next(0)).toMatchObject({ status: 404, body: { error: { code: "WORKER_NOT_FOUND" } } });

    const [r1] = await registerRunners(ctx.bridge, "w-1");
    const { bus } = ctx.bridge;
    const { task_id } = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });
    await r1!.pickUp();
    // Started trễ ~8s, session_id null; init đến sau vài dòng hook + dòng của runner.
    await r1!.started(task_id, null, 1);
    await r1!.events(task_id, [
      { type: "system", subtype: "hook_started", hook: "x" },
      { type: "runner_notice", subtype: "events_dropped", count: 3 },
      { type: "raw", text: "not json" },
    ]);
    expect(bus.getTask(task_id)?.session_id).toBeNull();
    await r1!.events(task_id, [{ type: "system", subtype: "init", session_id: "claude-late" }]);
    expect(bus.getTask(task_id)?.session_id).toBe("claude-late");
    const stored = ctx.bridge.eventLog.readSessionEvents({ task_id }).map((r) => r.event);
    expect(stored[1]).toEqual({ type: "runner_notice", subtype: "events_dropped", count: 3 });
    expect(stored[2]).toEqual({ type: "raw", text: "not json" });

    bus.completeTask(task_id, { mr_url: "https://git.example/mr/1", branch: "b", summary: "s" });
    expect(await r1!.started(task_id)).toMatchObject({ status: 409, body: { error: { code: "TASK_NOT_ACTIVE" } } });
    // Dòng stream cuối (result) đến sau complete_task vẫn được lưu.
    expect((await r1!.events(task_id, [{ type: "result", subtype: "success" }])).status).toBe(200);
    for (let i = 0; i < 2; i++) {
      expect(await r1!.exited(task_id, { exit_code: 0, usage: { output_tokens: 42 } })).toMatchObject({ status: 200, body: { ok: true } });
    }
    expect(bus.getTask(task_id)).toMatchObject({ state: "completed", usage: { output_tokens: 42 } });

    // Runner tắt giữa chừng.
    const second = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-2" }).task_id;
    await r1!.pickUp();
    await r1!.started(second);
    await r1!.exited(second, { exit_code: null, reason: null, message: "runner shutdown" });
    expect(bus.getTask(second)).toMatchObject({ state: "failed", fail_category: "no_terminal_report", fail_reason: "runner shutdown" });
  });

  it("report_progress on an assigned task implies running", async () => {
    await registerRunners(ctx.bridge, "w-1");
    const { bus } = ctx.bridge;
    const { task_id } = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });
    bus.reportProgress(task_id, { phase: "understanding", message: "reading ticket" });
    expect(bus.getTask(task_id)).toMatchObject({ state: "running", phase: "understanding" });
    const events = ctx.bridge.eventLog.readBusEventsSince(0);
    expect(events.map((e) => e.type)).toEqual(["worker.registered", "task.assigned", "task.started", "task.progress"]);
    expect(events[3]?.payload).toEqual({ phase: "understanding", message: "reading ticket" });
  });
});

describe("dispatch pause (7.9) and ticket.created", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await startBridge({ config: { agent_label: "agent" } });
  });
  afterEach(async () => {
    await ctx.bridge.close();
    removeDir(ctx.dir);
  });

  it("assign_task → DISPATCH_PAUSED while paused; running tasks unaffected", async () => {
    const [r1] = await registerRunners(ctx.bridge, "w-1", "w-2");
    const { bus } = ctx.bridge;
    const { task_id } = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });
    await r1!.pickUp();
    await r1!.started(task_id);

    expect(bus.setDispatchPaused(true)).toBe(true);
    expect(bus.setDispatchPaused(true)).toBe(false);
    expect(() => bus.assignTask({ worker_id: "w-2", ticket_key: "SH-2" })).toThrow(BusError);
    try {
      bus.assignTask({ worker_id: "w-2", ticket_key: "SH-2" });
    } catch (err) {
      expect((err as BusError).code).toBe("DISPATCH_PAUSED");
    }
    bus.completeTask(task_id, { mr_url: "https://git.example/mr/1", branch: "b", summary: "s" });
    expect(bus.getTask(task_id)?.state).toBe("completed");
    expect(ctx.bridge.status.get().dispatch_paused).toBe(true);

    bus.setDispatchPaused(false);
    expect(bus.assignTask({ worker_id: "w-2", ticket_key: "SH-2" }).task_id).toMatch(/^t-/);
    expect(busEventTypes(ctx.bridge)).toEqual(expect.arrayContaining(["dispatch.paused", "dispatch.resumed"]));
  });

  it("emitTicketCreated writes ticket.created with has_agent_label", () => {
    const { bus } = ctx.bridge;
    const e1 = bus.emitTicketCreated({ ticket_key: "SH-10", session_id: "s-1", labels: ["agent", "backend"] });
    const e2 = bus.emitTicketCreated({ ticket_key: "SH-11", session_id: "s-1", labels: [] });
    expect(e1).toMatchObject({ type: "ticket.created", ticket_key: "SH-10", payload: { session_id: "s-1", has_agent_label: true } });
    expect(e2.payload.has_agent_label).toBe(false);
    expect(ctx.bridge.eventLog.readBusEventsSince(e1.seq)).toHaveLength(1);
    expect(() => bus.emitTicketCreated({ ticket_key: "not a key", session_id: "s", labels: [] })).toThrow(BusError);
  });
});
