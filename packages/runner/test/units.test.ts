import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BusNetworkError } from "../src/busClient.js";
import { buildClaudeArgs, effectiveAllowedTools } from "../src/claudeInvocation.js";
import { planSpawn } from "../src/commandResolver.js";
import { ConfigError, parseConfig, readBootstrapToken } from "../src/config.js";
import { EventForwarder } from "../src/eventForwarder.js";
import { createLogger } from "../src/logger.js";
import { usageFromResult } from "../src/streamJson.js";

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
