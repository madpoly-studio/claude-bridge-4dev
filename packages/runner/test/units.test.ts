import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BusNetworkError } from "../src/busClient.js";
import { buildClaudeArgs, effectiveAllowedTools } from "../src/claudeInvocation.js";
import { planSpawn } from "../src/commandResolver.js";
import { ConfigError, parseConfig, readBootstrapToken } from "../src/config.js";
import { EventForwarder } from "../src/eventForwarder.js";
import { LiveResources } from "../src/liveResources.js";
import { createLogger } from "../src/logger.js";
import { DescendantSet, fileTimeFromMs, parseProcessSnapshot, type ProcessEntry } from "../src/processSnapshot.js";
import { treeSpawnOptions } from "../src/processTree.js";
import { usageFromResult } from "../src/streamJson.js";
import { waitFor } from "./helpers/fakeBus.js";
import { isProcessAlive } from "./helpers/harness.js";

const silent = createLogger({ level: "error", sink: () => undefined });
const minimalSlot = { worker_id: "w1", repo: "r", worktree_path: "wt", allowed_tools: ["Read"] };

describe("config", () => {
  it("applies defaults and resolves paths against the config directory", () => {
    const base = path.resolve("/tmp/cfg");
    const cfg = parseConfig({ slots: [minimalSlot] }, base);
    expect(cfg.bus_url).toBe("http://127.0.0.1:8787");
    expect(cfg.heartbeat_seconds).toBe(15);
    expect(cfg.claude_command).toEqual(["claude"]);
    expect(cfg.host).toBe(os.hostname());
    expect(cfg.bootstrap_token_file).toBe(path.join(base, "data", "runner-bootstrap.token"));
    expect(cfg.slots[0]).toMatchObject({
      worktree_path: path.join(base, "wt"),
      permission_mode: "dontAsk",
      disallowed_tools: [],
      extra_args: [],
      env: {},
    });
  });

  it("rejects duplicate worker ids and unknown permission modes", () => {
    expect(() => parseConfig({ slots: [minimalSlot, minimalSlot] }, ".")).toThrow(ConfigError);
    expect(() => parseConfig({ slots: [{ ...minimalSlot, permission_mode: "yolo" }] }, ".")).toThrow(/permission_mode/);
    expect(() => parseConfig({ slots: [] }, ".")).toThrow(ConfigError);
  });

  it("reads the bootstrap token from env first, then from the file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "runner-cfg-"));
    try {
      const file = path.join(dir, "token");
      writeFileSync(file, "  file-token \n");
      expect(await readBootstrapToken(file, {})).toBe("file-token");
      expect(await readBootstrapToken(file, { RUNNER_BOOTSTRAP_TOKEN: "env-token" })).toBe("env-token");
      await expect(readBootstrapToken(path.join(dir, "missing"), {})).rejects.toThrow(ConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claude invocation", () => {
  it("always allows the worker bus tools and appends disallowed tools and extra args", () => {
    const slot = parseConfig(
      {
        slots: [
          {
            ...minimalSlot,
            allowed_tools: ["Read", "mcp__bridge-bus__complete_task"],
            disallowed_tools: ["Bash(git push --force:*)"],
            extra_args: ["--model", "sonnet"],
            mcp_config_files: ["mcp/jira-gitlab.json"],
          },
        ],
      },
      "/cfg",
    ).slots[0]!;
    const extraMcp = path.resolve("/cfg", "mcp/jira-gitlab.json");
    expect(slot.mcp_config_files).toEqual([extraMcp]);
    expect(effectiveAllowedTools(slot)).toEqual([
      "Read",
      "mcp__bridge-bus__complete_task",
      "mcp__bridge-bus__report_progress",
      "mcp__bridge-bus__fail_task",
    ]);
    const args = buildClaudeArgs(slot, "C:\\tmp\\mcp.json");
    expect(args.slice(-4)).toEqual(["--disallowedTools", "Bash(git push --force:*)", "--model", "sonnet"]);
    const mcpAt = args.indexOf("--mcp-config");
    expect(args.slice(mcpAt + 1, mcpAt + 4)).toEqual(["C:\\tmp\\mcp.json", extraMcp, "--strict-mcp-config"]);
  });

  it("usage combines result.usage and total_cost_usd", () => {
    expect(usageFromResult({ type: "result", usage: { input_tokens: 1 }, total_cost_usd: 0.5 })).toEqual({
      input_tokens: 1,
      total_cost_usd: 0.5,
    });
    expect(usageFromResult({ type: "result" })).toBeNull();
    expect(usageFromResult(null)).toBeNull();
  });
});

describe("event forwarder", () => {
  it("keeps order across retries and marks dropped events when the buffer overflows", async () => {
    const received: unknown[] = [];
    let failures = 2;
    const forwarder = new EventForwarder({
      send: async (events) => {
        if (failures > 0) {
          failures -= 1;
          throw new BusNetworkError("down");
        }
        received.push(...events);
      },
      flushIntervalMs: 10,
      maxBatch: 3,
      maxBuffered: 5,
      backoff: { baseMs: 1, capMs: 5 },
      signal: new AbortController().signal,
      logger: silent,
    });
    for (let i = 0; i < 8; i++) {
      forwarder.push(i);
    }
    forwarder.open();
    const result = await forwarder.close();
    expect(received).toEqual([{ type: "runner_notice", subtype: "events_dropped", count: 3 }, 3, 4, 5, 6, 7]);
    expect(result.dropped).toBe(3);
  });
});

describe.runIf(process.platform === "win32")("windows .cmd shim spawning", () => {
  it("passes arguments with spaces, quotes and cmd metacharacters through a .cmd shim unchanged", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "runner shim "));
    try {
      const echo = path.join(dir, "echo-args.mjs");
      writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      const shim = path.join(dir, "fakeclaude.cmd");
      // Same shape as the npm-generated shim.
      writeFileSync(shim, `@ECHO off\r\n"${process.execPath}" "%~dp0\\echo-args.mjs" %*\r\n`);
      const args = ["-p", "Bash(git:*)", "a b", 'say "hi"', "x&calc", "100%", "%PATH%", "a|b", "^caret", "trailing\\"];
      const plan = await planSpawn([shim], args);
      expect(plan.windowsVerbatimArguments).toBe(true);
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(plan.file, plan.args, { windowsVerbatimArguments: true, windowsHide: true });
        let stdout = "";
        child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
        child.on("error", reject);
        child.on("close", () => resolve(stdout));
      });
      expect(JSON.parse(out)).toEqual(args);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a bare command name through PATH (where.exe)", async () => {
    const plan = await planSpawn(["git"], ["--version"]);
    expect(path.isAbsolute(plan.file)).toBe(true);
    expect(execFileSync(plan.file, plan.args, { windowsHide: true }).toString()).toMatch(/git version/);
  });
});

describe("process snapshot bookkeeping (win32 leftover reaping)", () => {
  const entry = (pid: number, ppid: number, created: number): ProcessEntry => ({ pid, ppid, created: BigInt(created) });
  const pids = (set: DescendantSet): number[] => set.descendants().map((p) => p.pid).sort((a, b) => a - b);

  it("parses snapshot lines and converts times to FILETIME", () => {
    const parsed = parseProcessSnapshot("0 0 0\r\n4 0 134377536647778770\r\n\r\nWARNING: something\r\n 12 4 5 \n");
    expect(parsed).toEqual([entry(0, 0, 0), { pid: 4, ppid: 0, created: 134377536647778770n }, entry(12, 4, 5)]);
    expect(fileTimeFromMs(0)).toBe(116_444_736_000_000_000n);
  });

  it("follows descendants across snapshots, through dead parents, and ignores pid reuse", () => {
    const set = new DescendantSet({ pid: 100, created: 1000n });
    set.record([
      entry(100, 1, 1000), // root
      entry(200, 100, 1100), // claude's Bash
      entry(300, 200, 1200), // dev server started from it
      entry(400, 100, 900), // older than the root: child of a previous owner of pid 100
      entry(500, 7, 1300), // unrelated
    ]);
    expect(pids(set)).toEqual([200, 300]);

    // Root and Bash exited; pid 100 now belongs to an unrelated newer process with its own child.
    set.record([
      entry(100, 9, 5000),
      entry(600, 100, 5100), // child of the new owner of pid 100
      entry(300, 200, 1200),
      entry(700, 300, 2000), // spawned by the dev server
      entry(800, 200, 1500), // spawned by Bash before it died, missed by the previous snapshot
    ]);
    expect(pids(set)).toEqual([300, 700, 800]);

    // The dev server exited and its pid was reused: the new holder must not be killed.
    set.record([entry(300, 1, 9000), entry(700, 300, 2000), entry(800, 200, 1500)]);
    expect(pids(set)).toEqual([700, 800]);
  });
});

describe("live resources (second-signal / exit cleanup)", () => {
  it("synchronously kills registered process trees and deletes registered temp dirs", async () => {
    const resources = new LiveResources();
    const dir = mkdtempSync(path.join(os.tmpdir(), "runner-live-"));
    writeFileSync(path.join(dir, "mcp-config.json"), "{}");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true, ...treeSpawnOptions() });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const pid = child.pid!;
      resources.addChild(pid);
      resources.addTempDir(dir);

      resources.cleanupSync(silent);

      expect(existsSync(dir)).toBe(false);
      await waitFor(() => !isProcessAlive(pid) || undefined, 5_000, "child to die");
      // Forgotten after cleanup: a second call has nothing left to do.
      resources.cleanupSync(createLogger({ level: "debug", sink: () => expect.fail("nothing should be logged") }));
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
