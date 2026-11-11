// Phase 1 exit criterion: 6 bất biến của Task Bus (system design mục 7.3).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusError } from "../src/bus/errors.js";
import { type TestContext, busEventTypes, registerRunners, removeDir, startBridge } from "./helpers.js";

function busErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof BusError) return err.code;
    throw err;
  }
  throw new Error("expected a BusError");
}

describe("Task Bus invariants (7.3)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await startBridge({ config: { max_concurrency: 2 } });
  });
  afterEach(async () => {
    await ctx.bridge.close();
    removeDir(ctx.dir);
  });

  it("1. a ticket has at most one active task", async () => {
    const { bus } = ctx.bridge;
    await registerRunners(ctx.bridge, "w-1", "w-2");
    bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });
    expect(busErrorCode(() => bus.assignTask({ worker_id: "w-2", ticket_key: "SH-1" }))).toBe("TICKET_ALREADY_ACTIVE");
    expect(bus.listTasks({ ticket_key: "SH-1" })).toHaveLength(1);

    // Backstop ở DB: partial unique index chặn ghi trực tiếp.
    expect(() =>
      ctx.bridge.db
        .prepare("INSERT INTO tasks (task_id, ticket_key, worker_id, state, attempt, assigned_at) VALUES ('x', 'SH-1', 'w-2', 'running', 1, 'now')")
        .run(),
    ).toThrow(/UNIQUE constraint failed: tasks.ticket_key/);
  });

  it("2. a worker has at most one active task", async () => {
    const { bus } = ctx.bridge;
    await registerRunners(ctx.bridge, "w-1");
    bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });
    expect(busErrorCode(() => bus.assignTask({ worker_id: "w-1", ticket_key: "SH-2" }))).toBe("WORKER_NOT_IDLE");
    expect(busErrorCode(() => bus.assignTask({ worker_id: "w-404", ticket_key: "SH-2" }))).toBe("WORKER_NOT_FOUND");

    expect(() =>
      ctx.bridge.db
        .prepare("INSERT INTO tasks (task_id, ticket_key, worker_id, state, attempt, assigned_at) VALUES ('x', 'SH-9', 'w-1', 'assigned', 1, 'now')")
        .run(),
    ).toThrow(/UNIQUE constraint failed: tasks.worker_id/);
  });

  it("3. active tasks never exceed max_concurrency (assigned counts too)", async () => {
    const { bus } = ctx.bridge;
    const [r1] = await registerRunners(ctx.bridge, "w-1", "w-2", "w-3");
    const { task_id } = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });
    bus.assignTask({ worker_id: "w-2", ticket_key: "SH-2" });
    expect(busErrorCode(() => bus.assignTask({ worker_id: "w-3", ticket_key: "SH-3" }))).toBe("CONCURRENCY_LIMIT");
    expect(ctx.bridge.status.get().running).toBe(2);

    // Một task kết thúc → có chỗ cho task mới.
    await r1!.pickUp();
    await r1!.started(task_id);
    bus.completeTask(task_id, { mr_url: "https://git.example/mr/1", branch: "feat/SH-1", summary: "done" });
    bus.assignTask({ worker_id: "w-3", ticket_key: "SH-3" });
    expect(bus.status().active).toBe(2);
  });

  it("4. assign_task is atomic: a failure mid-transaction leaves no trace", async () => {
    const { bus, db } = ctx.bridge;
    await registerRunners(ctx.bridge, "w-1");
    const notified = vi.fn();
    ctx.bridge.core.onTaskUpdated(notified);
    const seqBefore = ctx.bridge.eventLog.lastSeq();
    // Làm hỏng bước cuối (ghi event task.assigned) sau khi task + worker đã được ghi trong transaction.
    db.exec(`CREATE TRIGGER fail_assign BEFORE INSERT ON events WHEN NEW.type = 'task.assigned'
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    expect(() => bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" })).toThrow(/injected failure/);

    expect(bus.listTasks()).toHaveLength(0);
    expect(bus.listWorkers()[0]).toMatchObject({ state: "idle", current_task_id: null });
    expect(ctx.bridge.eventLog.lastSeq()).toBe(seqBefore);
    expect(notified).not.toHaveBeenCalled();

    db.exec("DROP TRIGGER fail_assign");
    expect(bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" }).task_id).toMatch(/^t-/);
  });

  it("5. terminal states are immutable; retry is a new task with attempt + 1", async () => {
    const { bus, db } = ctx.bridge;
    const [r1] = await registerRunners(ctx.bridge, "w-1");
    const first = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" }).task_id;
    await r1!.pickUp();
    await r1!.started(first);
    bus.failTask(first, { category: "build_failed", reason: "tests red" });

    expect(busErrorCode(() => bus.completeTask(first, { mr_url: "https://git.example/mr/1", branch: "b", summary: "s" }))).toBe(
      "TASK_NOT_ACTIVE",
    );
    expect(busErrorCode(() => bus.reportProgress(first, { phase: "testing", message: "again" }))).toBe("TASK_NOT_ACTIVE");
    expect(busErrorCode(() => bus.cancelTask({ task_id: first, reason: "late" }))).toBe("TASK_ALREADY_TERMINAL");
    // Exit muộn của process không đổi kết quả.
    expect((await r1!.exited(first, { exit_code: 1 })).status).toBe(200);
    expect(bus.getTask(first)).toMatchObject({ state: "failed", fail_category: "build_failed", fail_reason: "tests red" });

    // Backstop ở DB: trigger chặn sửa trực tiếp.
    expect(() => db.prepare("UPDATE tasks SET state = 'running' WHERE task_id = ?").run(first)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE tasks SET fail_reason = 'x' WHERE task_id = ?").run(first)).toThrow(/immutable/);

    const retry = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" }).task_id;
    expect(retry).not.toBe(first);
    expect(bus.getTask(retry)).toMatchObject({ attempt: 2, state: "assigned" });
    expect(bus.getTask(first)?.state).toBe("failed");
  });

  it("6. the bus never writes to Jira (no outbound network during a full task lifecycle)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const { bus } = ctx.bridge;
      const [r1] = await registerRunners(ctx.bridge, "w-1");
      const { task_id } = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-7" });
      await r1!.pickUp();
      await r1!.started(task_id);
      bus.reportProgress(task_id, { phase: "implementing", message: "coding" });
      bus.completeTask(task_id, { mr_url: "https://git.example/mr/7", branch: "feat/SH-7", summary: "ok" });
      await r1!.exited(task_id);
      bus.emitTicketCreated({ ticket_key: "SH-8", session_id: "s-1", labels: ["agent"] });
      bus.setDispatchPaused(true);
      ctx.bridge.sweeper.sweep();
      expect(busEventTypes(ctx.bridge)).toContain("task.completed");
    } finally {
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }

    // Tĩnh: module bus không import client HTTP / Jira nào.
    const busDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bus");
    for (const file of readdirSync(busDir)) {
      const source = readFileSync(join(busDir, file), "utf8");
      expect(source, file).not.toMatch(/\bfetch\(|from "node:https?"|from "undici"|\/jira\//);
    }
  });
});
