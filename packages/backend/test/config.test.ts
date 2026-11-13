import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "@claude-bridge/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_JIRA_CREATE_TOOL_PATTERN, loadConfig, parseConfig } from "../src/config.js";
import { resolveRunnerBootstrapToken } from "../src/bus/tokens.js";
import { removeDir, tempDir } from "./helpers.js";

describe("config", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => removeDir(dir));

  it("uses defaults when no file exists", () => {
    const cfg = loadConfig({}, dir);
    expect(cfg).toMatchObject({
      port: DEFAULTS.PORT,
      data_dir: join(dir, "data"),
      max_concurrency: 2,
      task_timeout_minutes: 60,
      agent_label: "agent",
      claude_auth_mode: "subscription",
      jira_create_tool_pattern: DEFAULT_JIRA_CREATE_TOOL_PATTERN,
      allowed_origins: [],
      config_path: null,
    });
    expect(new RegExp(cfg.jira_create_tool_pattern).test("mcp__jira__create_issue")).toBe(true);
    expect(new RegExp(cfg.jira_create_tool_pattern).test("mcp__jira__get_issue")).toBe(false);
  });

  it("reads the file, resolves paths against it, and applies env overrides", () => {
    const file = join(dir, "bridge.config.json");
    writeFileSync(
      file,
      JSON.stringify({
        port: 9000,
        data_dir: "./state",
        allowed_origins: ["https://a.example"],
        repos: [{ name: "r", path: "D:/r" }],
        jira_env_file: ".env",
        max_concurrency: 3,
      }),
    );
    const cfg = loadConfig(
      { BRIDGE_CONFIG: file, MAX_CONCURRENCY: "5", ALLOWED_ORIGINS: "https://x.example, https://y.example", BRIDGE_PAIRING_TOKEN: "p".repeat(20) },
      "C:/elsewhere",
    );
    expect(cfg).toMatchObject({
      port: 9000,
      data_dir: join(dir, "state"),
      jira_env_file: join(dir, ".env"),
      max_concurrency: 5,
      allowed_origins: ["https://x.example", "https://y.example"],
      repos: [{ name: "r", path: "D:/r", project_key: null }],
      pairing_token: "p".repeat(20),
      config_path: file,
    });
  });

  it("rejects invalid values and unknown keys", () => {
    writeFileSync(join(dir, "bridge.config.json"), JSON.stringify({ max_concurrency: 0, bogus: true }));
    expect(() => loadConfig({}, dir)).toThrow(ConfigError);
    expect(() => loadConfig({ BRIDGE_CONFIG: "missing.json" }, dir)).toThrow(/missing file/);
    expect(() => loadConfig({ BRIDGE_PORT: "abc" }, join(dir, "nowhere"))).toThrow(/BRIDGE_PORT/);
    expect(() => loadConfig({ CLAUDE_AUTH_MODE: "magic" }, join(dir, "nowhere"))).toThrow(ConfigError);
  });

  it("wake_mode: manual by default, auto from the file or WAKE_MODE (env wins), anything else rejected", () => {
    expect(loadConfig({}, dir).wake_mode).toBe("manual");
    expect(parseConfig({ wake_mode: "auto" }, dir).wake_mode).toBe("auto");
    writeFileSync(join(dir, "bridge.config.json"), JSON.stringify({ wake_mode: "auto" }));
    expect(loadConfig({}, dir).wake_mode).toBe("auto");
    expect(loadConfig({ WAKE_MODE: "manual" }, dir).wake_mode).toBe("manual");
    expect(() => parseConfig({ wake_mode: "sometimes" }, dir)).toThrow(/wake_mode/);
    expect(() => loadConfig({ WAKE_MODE: "always" }, dir)).toThrow(ConfigError);
  });

  it("bridge.config.example.json at the repo root is valid", () => {
    const example = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bridge.config.example.json");
    const cfg = loadConfig({ BRIDGE_CONFIG: example }, dir);
    expect(cfg.repos.length).toBeGreaterThan(0);
    expect(cfg.pairing_token).toBeNull();
  });

  it("planner / orchestrators: defaults, path resolution and validation", () => {
    const defaults = parseConfig({}, dir);
    expect(defaults.planner).toEqual({ mcp_servers: {}, allowed_tools: [], system_prompt_append: null, model: null, setting_sources: [] });
    expect(defaults).toMatchObject({ orchestrators: {}, orchestrator_autostart: true, claude_executable: null });

    const cfg = parseConfig(
      {
        projects: ["SH"],
        planner: { allowed_tools: ["mcp__jira__jira_get_*"], mcp_servers: { jira: { type: "http", url: "http://127.0.0.1:9000/mcp" } } },
        orchestrators: { SH: { cwd: "./orch/SH", setting_sources: ["project"] } },
      },
      dir,
    );
    expect(cfg.orchestrators.SH).toMatchObject({ cwd: join(dir, "orch", "SH"), setting_sources: ["project"], allowed_tools: [] });
    expect(cfg.planner.mcp_servers.jira).toEqual({ type: "http", url: "http://127.0.0.1:9000/mcp" });

    expect(() => parseConfig({ projects: [], orchestrators: { SH: { cwd: "x" } } }, dir)).toThrow(/not listed in projects/);
    expect(() => parseConfig({ planner: { allowed_tools: ["mcp__*__get"] } }, dir)).toThrow(/trailing \* wildcard/);
    expect(() => parseConfig({ planner: { mcp_servers: { "bridge-bus": { command: "x" } } } }, dir)).toThrow(/reserved/);
    expect(() => parseConfig({ planner: { mcp_servers: { jira: { type: "http" } } } }, dir)).toThrow(ConfigError);
  });

  it("runner bootstrap token: config wins, else generated once and persisted", () => {
    expect(resolveRunnerBootstrapToken("configured-token-0123456789", dir)).toBe("configured-token-0123456789");
    const generated = resolveRunnerBootstrapToken(null, dir);
    expect(generated.length).toBeGreaterThanOrEqual(32);
    expect(resolveRunnerBootstrapToken(null, dir)).toBe(generated);
  });
});
