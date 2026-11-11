// Phase 2 (mục 18): bus thật + runner thật + claude giả.
// - Một task chạy hết vòng assigned → running → completed.
// - Kill process claude giữa chừng → failed(no_terminal_report).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BridgeApp, createApp } from "../packages/backend/src/app.js";
import { parseConfig } from "../packages/backend/src/config.js";

const ROOT = resolve(__dirname, "..");
const RUNNER_ENTRY = join(ROOT, "packages/runner/src/index.ts");
const FAKE_CLAUDE = join(ROOT, "packages/runner/test/fixtures/fake-claude.mjs");
const BOOTSTRAP = "e2e-bootstrap-token-0123456789abcdef";
const WORKER_ID = "w-e2e-01";

let dir: string;
let bridge: BridgeApp;
let runner: ChildProcess | null = null;
let runnerLog = "";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}\n--- runner log ---\n${runnerLog}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function callOrchestratorTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(bridge.mcpUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bridge.tokens.getOrchestratorToken()}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean } };
  const text = body.result?.content?.[0]?.text ?? "null";
  if (body.result?.isError) throw new Error(text);
  return JSON.parse(text);
}

async function startStack(slotEnv: Record<string, string>): Promise<void> {
  const config = parseConfig(
    {
      port: 0,
      data_dir: dir,
      allowed_origins: ["http://localhost:5173"],
      projects: ["E2E"],
      repos: [{ name: "e2e", path: join(dir, "wt"), project_key: "E2E" }],
      pairing_token: "e2e-pairing-token-0123456789",
      runner_bootstrap_token: BOOTSTRAP,
    },
    dir,
  );
  bridge = await createApp(config, { sweepIntervalMs: 500 });
  await bridge.listen();

  const runnerConfig = join(dir, "runner.config.json");
  writeFileSync(
    runnerConfig,
    JSON.stringify({
      bus_url: bridge.baseUrl(),
      claude_command: [process.execPath, FAKE_CLAUDE],
      heartbeat_seconds: 1,
      slots: [
        {
          worker_id: WORKER_ID,
          repo: "e2e",
          worktree_path: join(dir, "wt"),
          allowed_tools: ["Read"],
          env: slotEnv,
        },
      ],
    }),
  );
  runner = spawn(process.execPath, ["--import", "tsx", RUNNER_ENTRY, "--config", runnerConfig], {
    cwd: ROOT,
    env: { ...process.env, RUNNER_BOOTSTRAP_TOKEN: BOOTSTRAP },
    stdio: ["ignore", "pipe", "pipe"],
  });
  runner.stdout?.on("data", (d) => (runnerLog += d));
  runner.stderr?.on("data", (d) => (runnerLog += d));

  await waitFor("worker idle", () => bridge.bus.listWorkers({}).find((w) => w.worker_id === WORKER_ID && w.state === "idle"));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-e2e-"));
  const wt = join(dir, "wt");
  execFileSync("git", ["init", "-q", wt]);
  git(wt, "config", "user.email", "e2e@example.test");
  git(wt, "config", "user.name", "e2e");
  writeFileSync(join(wt, "README.md"), "e2e\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "init");
  runnerLog = "";
});

afterEach(async () => {
  if (runner && runner.exitCode === null) {
    runner.kill();
    await new Promise((r) => runner?.once("exit", r));
  }
  runner = null;
  await bridge?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("bus + runner + fake claude", () => {
  it("chạy hết vòng assigned → running → completed", async () => {
    await startStack({ FAKE_CLAUDE_MODE: "complete", FAKE_CLAUDE_EXTRA_LINES: "3" });

    const { task_id } = (await callOrchestratorTool("assign_task", {
      worker_id: WORKER_ID,
      ticket_key: "E2E-1",
      notes: "e2e",
    })) as { task_id: string };

    const done = await waitFor("task completed", () => {
      const t = bridge.bus.getTask(task_id);
      return t && t.state === "completed" ? t : undefined;
    });
    expect(done.mr_url).toBeTruthy();
    expect(done.session_id).toBeTruthy();

    const types = bridge.eventLog.readBusEventsSince(0).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["worker.registered", "task.assigned", "task.started", "task.completed"]));
    expect(types.indexOf("task.assigned")).toBeLessThan(types.indexOf("task.started"));
    expect(types.indexOf("task.started")).toBeLessThan(types.indexOf("task.completed"));

    // Runner báo exited → worker quay về idle, usage được ghi.
    await waitFor("worker idle again", () =>
      bridge.bus.listWorkers({}).find((w) => w.worker_id === WORKER_ID && w.state === "idle" && !w.current_task_id),
    );
    await waitFor("usage recorded", () => bridge.bus.getTask(task_id)?.usage);
    // Stream của worker được lưu theo task.
    const events = bridge.eventLog.readSessionEvents({ task_id });
    expect(events.length).toBeGreaterThan(3);
  });

  it("kill process claude giữa chừng → failed(no_terminal_report)", async () => {
    const record = join(dir, "fake-claude-record.json");
    await startStack({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RECORD_FILE: record });

    const { task_id } = (await callOrchestratorTool("assign_task", {
      worker_id: WORKER_ID,
      ticket_key: "E2E-2",
    })) as { task_id: string };

    await waitFor("task running", () => bridge.bus.getTask(task_id)?.state === "running");
    await waitFor("fake claude pid", () => existsSync(record));
    const { pid } = JSON.parse(readFileSync(record, "utf8")) as { pid: number };
    process.kill(pid);

    const failed = await waitFor("task failed", () => {
      const t = bridge.bus.getTask(task_id);
      return t && t.state === "failed" ? t : undefined;
    });
    expect(failed.fail_category).toBe("no_terminal_report");
    await waitFor("worker idle again", () =>
      bridge.bus.listWorkers({}).find((w) => w.worker_id === WORKER_ID && w.state === "idle"),
    );
  });
});
