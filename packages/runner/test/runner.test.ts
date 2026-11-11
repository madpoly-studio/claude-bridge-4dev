import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { busToolFullName, WORKER_TOOLS } from "@claude-bridge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "./helpers/fakeBus.js";
import { hasGit, isProcessAlive, startHarness, WORKER_ID, type Harness } from "./helpers/harness.js";

interface FakeRecord {
  argv: string[];
  prompt: string;
  cwd: string;
  mcp_config_path: string | null;
  mcp_config_existed: boolean;
  has_bootstrap_token_env: boolean;
  pid: number;
  grandchild_pid: number | null;
}

const readRecord = (h: Harness): FakeRecord => JSON.parse(readFileSync(h.recordFile, "utf8")) as FakeRecord;

/** Values after a variadic flag, up to the next `--flag`. */
function flagValues(argv: string[], flag: string): string[] {
  const start = argv.indexOf(flag);
  if (start < 0) {
    return [];
  }
  const values: string[] = [];
  for (let i = start + 1; i < argv.length && !argv[i]!.startsWith("--"); i++) {
    values.push(argv[i]!);
  }
  return values;
}

describe.skipIf(!hasGit)("worker runner against a fake bus", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    await harness?.stop();
    harness = null;
  });

  it("happy path: register → next → started(session_id) → ordered event batches → exited(0, usage)", async () => {
    const previousEnvToken = process.env.RUNNER_BOOTSTRAP_TOKEN;
    harness = await startHarness({ slotEnv: { FAKE_CLAUDE_EXTRA_LINES: "35" } });
    process.env.RUNNER_BOOTSTRAP_TOKEN = harness.bus.bootstrapToken;
    try {
      const { bus } = harness;
      const assignment = bus.enqueue(WORKER_ID);
      const taskId = assignment.task.task_id;
      const exited = await waitFor(() => bus.exited.get(taskId), 15_000, "exited");

      // register used the bootstrap token and described the slot
      const register = bus.callsTo("POST", "/runners/register")[0]!;
      expect(register.token).toBe(bus.bootstrapToken);
      expect(register.body).toMatchObject({ worker_id: WORKER_ID, repo: "sample-repo", host: "test-host", current_task_id: null });
      // every other runner call used the runner token, never the bootstrap token
      const runnerCalls = bus.calls.filter((c) => c.path !== "/runners/register" && c.path !== "/mcp");
      expect(runnerCalls.every((c) => c.token?.startsWith("runner-"))).toBe(true);

      // started carries the init session_id and the pid
      const record = readRecord(harness);
      const started = bus.started.get(taskId)!;
      const events = bus.eventsOf(taskId) as Array<Record<string, unknown>>;
      const init = events.find((e) => e.type === "system" && e.subtype === "init")!;
      expect(started.session_id).toBe(init.session_id);
      expect(started.pid).toBe(record.pid);

      // started is posted before any events
      const startedIndex = bus.calls.findIndex((c) => c.path.endsWith(`/${taskId}/started`));
      const firstEventsIndex = bus.calls.findIndex((c) => c.path.endsWith(`/${taskId}/events`));
      expect(startedIndex).toBeGreaterThanOrEqual(0);
      expect(startedIndex).toBeLessThan(firstEventsIndex);

      // all lines forwarded, in order, in batches of at most eventMaxBatch (10)
      const batches = bus.eventBatches.get(taskId)!;
      expect(batches.length).toBeGreaterThan(3);
      expect(batches.every((b) => b.length <= 10)).toBe(true);
      expect(events[0]).toMatchObject({ type: "system", subtype: "hook_started" });
      expect(events).toContainEqual({ type: "raw", text: "fake-claude: this line is not JSON" });
      const seqs = events.filter((e) => typeof e.seq === "number").map((e) => e.seq as number);
      expect(seqs).toEqual(Array.from({ length: 35 }, (_, i) => i));
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });

      // exited with usage + cost from the result line
      expect(exited).toMatchObject({ exit_code: 0, reason: null });
      expect(exited.usage).toMatchObject({ input_tokens: 120, output_tokens: 45, total_cost_usd: 0.0123 });

      // the worker reached the bus MCP with the task token
      expect(bus.mcpToolCalls).toEqual([
        expect.objectContaining({ token: assignment.task_token, name: "complete_task" }),
      ]);

      // CLI invocation: flags, allowlist incl. bus tools, prompt on stdin, MCP config file removed afterwards
      expect(record.argv.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
      expect(record.argv).toContain("--strict-mcp-config");
      expect(flagValues(record.argv, "--permission-mode")).toEqual(["dontAsk"]);
      expect(flagValues(record.argv, "--allowedTools")).toEqual([
        "Read",
        "Grep",
        "Bash(git:*)",
        ...WORKER_TOOLS.map((t) => busToolFullName(t)),
      ]);
      expect(record.prompt).toBe(assignment.prompt);
      expect(path.resolve(record.cwd)).toBe(path.resolve(harness.worktree));
      expect(record.mcp_config_existed).toBe(true);
      expect(existsSync(record.mcp_config_path!)).toBe(false);
      expect(record.has_bootstrap_token_env).toBe(false);

      // no secret ever reaches the log
      const log = harness.logLines.join("\n");
      expect(log).not.toContain(assignment.task_token);
      expect(log).not.toContain(bus.bootstrapToken);
      expect(log).not.toMatch(/runner-[0-9a-f-]{36}/);
    } finally {
      if (previousEnvToken === undefined) {
        delete process.env.RUNNER_BOOTSTRAP_TOKEN;
      } else {
        process.env.RUNNER_BOOTSTRAP_TOKEN = previousEnvToken;
      }
    }
  });

  it("dirty worktree: reports exited(conflict) without spawning", async () => {
    harness = await startHarness();
    writeFileSync(path.join(harness.worktree, "untracked.txt"), "local change");
    const taskId = harness.bus.enqueue(WORKER_ID).task.task_id;
    const exited = await waitFor(() => harness!.bus.exited.get(taskId), 10_000, "exited");

    expect(exited).toMatchObject({ exit_code: null, usage: null, reason: "conflict" });
    expect(exited.message).toContain("untracked.txt");
    expect(harness.bus.started.has(taskId)).toBe(false);
    expect(existsSync(harness.recordFile)).toBe(false);
  });

  it("worktree that is not a git repo: reports exited(spawn_error)", async () => {
    harness = await startHarness({ gitRepo: false });
    const taskId = harness.bus.enqueue(WORKER_ID).task.task_id;
    const exited = await waitFor(() => harness!.bus.exited.get(taskId), 10_000, "exited");

    expect(exited).toMatchObject({ exit_code: null, usage: null, reason: "spawn_error" });
    expect(existsSync(harness.recordFile)).toBe(false);
  });

  it("claude command that does not exist: reports exited(spawn_error)", async () => {
    harness = await startHarness({
      configure: (raw) => {
        raw.claude_command = ["claude-bridge-no-such-binary-xyz"];
      },
    });
    const taskId = harness.bus.enqueue(WORKER_ID).task.task_id;
    const exited = await waitFor(() => harness!.bus.exited.get(taskId), 10_000, "exited");

    expect(exited).toMatchObject({ exit_code: null, reason: "spawn_error" });
    expect(exited.message).toContain("claude-bridge-no-such-binary-xyz");
  });

  it("cancel via heartbeat: kills the process tree and reports exited(cancelled)", async () => {
    harness = await startHarness({ slotEnv: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_GRANDCHILD: "1" } });
    const { bus } = harness;
    const taskId = bus.enqueue(WORKER_ID).task.task_id;
    await waitFor(() => bus.started.get(taskId), 10_000, "started");
    const record = readRecord(harness);
    expect(isProcessAlive(record.pid)).toBe(true);

    bus.requestCancel(taskId);
    const exited = await waitFor(() => bus.exited.get(taskId), 10_000, "exited");

    expect(exited).toMatchObject({ reason: "cancelled", usage: null });
    expect(isProcessAlive(record.pid)).toBe(false);
    await waitFor(() => !isProcessAlive(record.grandchild_pid!) || undefined, 5_000, "grandchild to die");
    const heartbeat = bus.callsTo("POST", `/runners/${WORKER_ID}/heartbeat`).find((c) => {
      return (c.body as { current_task_id: string | null }).current_task_id === taskId;
    });
    expect(heartbeat).toBeDefined();
  });

  it("timeout: kills the process and reports exited(timeout)", async () => {
    harness = await startHarness({ slotEnv: { FAKE_CLAUDE_MODE: "hang" } });
    const taskId = harness.bus.enqueue(WORKER_ID, { timeout_seconds: 1 }).task.task_id;
    const exited = await waitFor(() => harness!.bus.exited.get(taskId), 10_000, "exited");

    expect(exited.reason).toBe("timeout");
    expect(exited.message).toContain("timeout");
    expect(isProcessAlive(readRecord(harness).pid)).toBe(false);
  });

  it("crash: reports the non-zero exit code with reason null and the stderr tail", async () => {
    harness = await startHarness({ slotEnv: { FAKE_CLAUDE_MODE: "crash" } });
    const taskId = harness.bus.enqueue(WORKER_ID).task.task_id;
    const exited = await waitFor(() => harness!.bus.exited.get(taskId), 10_000, "exited");

    expect(exited).toMatchObject({ exit_code: 3, reason: null, usage: null });
    expect(exited.message).toContain("simulated crash");
    expect(harness.bus.started.get(taskId)?.session_id).toEqual(expect.any(String));
  });

  it("no init line: falls back to started(session_id: null) while the process keeps running", async () => {
    harness = await startHarness({ slotEnv: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_NO_INIT: "1" } });
    const { bus } = harness;
    const taskId = bus.enqueue(WORKER_ID).task.task_id;
    const started = await waitFor(() => bus.started.get(taskId), 10_000, "started");

    expect(started.session_id).toBeNull();
    expect(isProcessAlive(readRecord(harness).pid)).toBe(true);
    bus.requestCancel(taskId);
    await waitFor(() => bus.exited.get(taskId), 10_000, "exited");
  });

  it("401: re-registers with the bootstrap token and keeps serving tasks", async () => {
    harness = await startHarness();
    const { bus } = harness;
    await waitFor(() => bus.callsTo("GET", `/runners/${WORKER_ID}/next`).length > 0 || undefined, 5_000, "first poll");

    bus.revokeRunnerTokens();
    await waitFor(() => bus.callsTo("POST", "/runners/register").length >= 2 || undefined, 5_000, "re-register");
    const taskId = bus.enqueue(WORKER_ID).task.task_id;
    const exited = await waitFor(() => bus.exited.get(taskId), 10_000, "exited");

    expect(exited.exit_code).toBe(0);
    expect(bus.calls.some((c) => c.status === 401)).toBe(true);
    const registers = bus.callsTo("POST", "/runners/register");
    expect(registers.every((c) => c.token === bus.bootstrapToken)).toBe(true);
  });

  it("204 long-poll: keeps polling and heartbeating while idle, then picks up a task", async () => {
    harness = await startHarness();
    const { bus } = harness;
    await waitFor(() => bus.callsTo("GET", `/runners/${WORKER_ID}/next`).filter((c) => c.status === 204).length >= 3 || undefined);
    await waitFor(() => bus.callsTo("POST", `/runners/${WORKER_ID}/heartbeat`).length >= 1 || undefined, 5_000, "idle heartbeat");
    expect(bus.callsTo("GET", `/runners/${WORKER_ID}/next`)[0]!.path).toBe(`/runners/${WORKER_ID}/next`);

    const taskId = bus.enqueue(WORKER_ID).task.task_id;
    const exited = await waitFor(() => bus.exited.get(taskId), 10_000, "exited");
    expect(exited.exit_code).toBe(0);
    expect(bus.callsTo("POST", "/runners/register")).toHaveLength(1);
  });

  it("events endpoint failing transiently: retries and still delivers every event in order", async () => {
    harness = await startHarness({ slotEnv: { FAKE_CLAUDE_EXTRA_LINES: "20" } });
    const { bus } = harness;
    bus.failEventsTimes = 3;
    const taskId = bus.enqueue(WORKER_ID).task.task_id;
    await waitFor(() => bus.exited.get(taskId), 10_000, "exited");

    const events = bus.eventsOf(taskId) as Array<Record<string, unknown>>;
    const seqs = events.filter((e) => typeof e.seq === "number").map((e) => e.seq as number);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(events.at(-1)).toMatchObject({ type: "result" });
    expect(bus.calls.filter((c) => c.path.endsWith("/events") && c.status === 503)).toHaveLength(3);
  });

  it("shutdown: kills the running task and reports exited(reason null, 'runner shutdown')", async () => {
    harness = await startHarness({ slotEnv: { FAKE_CLAUDE_MODE: "hang" } });
    const { bus } = harness;
    const taskId = bus.enqueue(WORKER_ID).task.task_id;
    await waitFor(() => bus.started.get(taskId), 10_000, "started");
    const pid = readRecord(harness).pid;

    harness.abort();
    await harness.done;

    expect(bus.exited.get(taskId)).toMatchObject({ reason: null, message: "runner shutdown" });
    expect(isProcessAlive(pid)).toBe(false);
  });
});
