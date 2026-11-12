// mps-bridge: the configs generated from settings.json must be accepted by the real backend and runner parsers.
// Catches drift between the copied validation rules in scripts/mps-bridge and the package schemas.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig as parseBridgeConfig } from "../packages/backend/src/config.js";
import { loadJiraSettings } from "../packages/backend/src/jira/jiraSettings.js";
import { parseConfig as parseRunnerConfig } from "../packages/runner/src/config.js";
import { buildClaudeArgs } from "../packages/runner/src/claudeInvocation.js";
import { TASK_PHASES, WORKER_FAIL_CATEGORIES } from "../packages/protocol/src/entities.js";
import { buildWorkspaceFiles } from "../scripts/mps-bridge/lib/generate.mjs";
import { validateSettings, realFs } from "../scripts/mps-bridge/lib/settings.mjs";
import { workspacePaths } from "../scripts/mps-bridge/lib/paths.mjs";
import { writeGenerated } from "../scripts/mps-bridge/lib/workspace.mjs";

const TOKEN = "e2e-pairing-token-0123456789abcdef";

let dir: string;

function gitRepo(name: string): string {
  const repo = join(dir, "repos", name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  return repo;
}

/** Validates `raw`, generates the workspace files and writes them; returns everything the assertions need. */
function generate(raw: Record<string, unknown>) {
  const p = workspacePaths(join(dir, "ws"));
  const result = validateSettings(raw, { workspace: p.root, fs: realFs });
  expect(result.errors).toEqual([]);
  const files = buildWorkspaceFiles(result.settings!, p, TOKEN);
  writeGenerated(p, files);
  const bridgeJson = JSON.parse(readFileSync(p.bridgeConfig, "utf8"));
  const runnerJson = JSON.parse(readFileSync(p.runnerConfig, "utf8"));
  const bridge = parseBridgeConfig(bridgeJson, p.generated, p.bridgeConfig);
  const runner = parseRunnerConfig(runnerJson, p.generated);
  return { p, files, bridge, runner };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mpsb-e2e-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("mps-bridge generated configs", () => {
  it("single project, 2 workers, CA bundle: accepted by both parsers and the Jira env loader", () => {
    const repo = gitRepo("sh-game");
    // "\new\ca.pem" would turn into a newline if the dotenv value were not escaped.
    const caDir = join(dir, "certs", "new");
    mkdirSync(caDir, { recursive: true });
    const ca = join(caDir, "ca.pem");
    writeFileSync(ca, "-----BEGIN CERTIFICATE-----\n");

    const { p, bridge, runner } = generate({
      jira: { url: "https://jira.example.com/", personal_token: "pat-123", ca_bundle: ca },
      projects: ["SH"],
      repos: [{ name: "sh-game", path: repo, project_key: "SH", base_branch: "develop", workers: 2, allowed_bash: ["npm test"] }],
    });

    expect(bridge.port).toBe(8787);
    expect(bridge.max_concurrency).toBe(2);
    expect(Object.keys(bridge.orchestrators)).toEqual(["SH"]);
    expect(runner.slots).toHaveLength(2);
    const repoNames = bridge.repos.map((r) => r.name);
    for (const slot of runner.slots) expect(repoNames).toContain(slot.repo);

    const jira = loadJiraSettings(p.teamEnv);
    expect(jira.status).toBe("ok");
    if (jira.status !== "ok") return;
    expect(jira.settings.ca).not.toBeNull();
    expect(jira.settings.projectKey).toBe("SH");
    expect(jira.settings.baseUrl).toBe("https://jira.example.com");
  });

  it("claude args: extra_args come last and the variadic disallowed list is terminated", () => {
    const repo = gitRepo("sh-game");
    const { runner } = generate({
      jira: { url: "https://jira.example.com", personal_token: "pat-123" },
      projects: ["SH"],
      repos: [{ name: "sh-game", path: repo, project_key: "SH", base_branch: "develop", workers: 2 }],
    });
    for (const slot of runner.slots) {
      const args = buildClaudeArgs(slot, "x.json");
      expect(args.slice(-slot.extra_args.length)).toEqual(slot.extra_args);
      const lastDisallowed = args.lastIndexOf(slot.disallowed_tools[slot.disallowed_tools.length - 1]!);
      expect(args[lastDisallowed + 1]).toBe("--append-system-prompt-file");
      // Workspace secrets are denied to the worker in the //<drive>/ form Claude Code matches on Windows.
      const denied = args.slice(args.indexOf("--disallowedTools") + 1, lastDisallowed + 1);
      expect(denied.some((a) => /^Read\(\/\/.+\/ws\/settings\.json\)$/.test(a))).toBe(true);
      expect(denied.some((a) => /^Edit\(\/\/.+\/ws\/generated\/\*\*\)$/.test(a))).toBe(true);
    }
  });

  it("worker-flow text names every task phase and worker fail category", () => {
    const a = gitRepo("sh-game");
    const b = gitRepo("sh-tools");
    const { files } = generate({
      jira: { url: "https://jira.example.com", personal_token: "pat-123" },
      projects: ["SH"],
      repos: [
        { name: "sh-game", path: a, project_key: "SH", base_branch: "develop" },
        { name: "sh-tools", path: b, project_key: "SH", base_branch: "main" },
      ],
    });
    const flows = Object.values(files.workerFlows);
    expect(flows).toHaveLength(2);
    for (const md of flows) {
      for (const word of [...TASK_PHASES, ...WORKER_FAIL_CATEGORIES]) expect(md).toContain(word);
    }
  });

  it("two projects, custom ports, worker model", () => {
    const a = gitRepo("sh-game");
    const b = gitRepo("ops-tool");
    const { bridge, runner } = generate({
      jira: { url: "https://jira.example.com", personal_token: "pat-123" },
      projects: ["SH", "OPS"],
      repos: [
        { name: "sh-game", path: a, project_key: "SH", base_branch: "develop" },
        { name: "ops-tool", path: b, project_key: "OPS", base_branch: "main" },
      ],
      models: { worker: "sonnet" },
      ports: { bridge: 9000, web: 5000 },
    });
    expect(runner.bus_url).toBe("http://127.0.0.1:9000");
    expect(bridge.allowed_origins).toEqual(["http://127.0.0.1:5000", "http://localhost:5000"]);
    expect(Object.keys(bridge.orchestrators).sort()).toEqual(["OPS", "SH"]);
    for (const slot of runner.slots) expect(slot.extra_args.slice(-2)).toEqual(["--model", "sonnet"]);
  });
});
