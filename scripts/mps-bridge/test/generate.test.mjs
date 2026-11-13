import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  WORKER_DISALLOWED_TOOLS,
  bashRule,
  buildWorkspaceFiles,
  dotenvQuote,
  permissionPath,
  workspaceSecretRules,
  worktreeSpecs,
} from "../lib/generate.mjs";
import { workspacePaths } from "../lib/paths.mjs";
import { validateSettings } from "../lib/settings.mjs";
import { APP_ROOT_FAKE, CA_FILE, REPO_B, WORKSPACE, fakeFs, validRaw } from "./helpers.mjs";

const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";
const paths = workspacePaths(WORKSPACE, APP_ROOT_FAKE);

/** @param {(raw: any) => void} [mutate] */
function build(mutate = () => {}) {
  const raw = validRaw();
  mutate(raw);
  const r = validateSettings(raw, { workspace: WORKSPACE, appRoot: APP_ROOT_FAKE, fs: fakeFs() });
  assert.deepEqual(r.errors, []);
  return buildWorkspaceFiles(/** @type {any} */ (r.settings), paths, TOKEN);
}

/** @param {unknown} value @returns {string[]} */
function underscoreKeys(value) {
  if (Array.isArray(value)) {
    return value.flatMap(underscoreKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [...(k.startsWith("_") ? [k] : []), ...underscoreKeys(v)]);
  }
  return [];
}

describe("buildWorkspaceFiles", () => {
  it("bridge config has no _* key at any depth", () => {
    assert.deepEqual(underscoreKeys(build().bridgeConfig), []);
  });

  it("allows both loopback origins for the web port", () => {
    const files = build((r) => { r.ports.web = 5000; });
    assert.deepEqual(files.bridgeConfig.allowed_origins, ["http://127.0.0.1:5000", "http://localhost:5000"]);
  });

  it("READ_ONLY_MODE only on orchestrators; REQUESTS_CA_BUNDLE only with a CA bundle", () => {
    const plain = build();
    const cfg = /** @type {any} */ (plain.bridgeConfig);
    assert.equal(cfg.orchestrators.SH.mcp_servers.jira.env.READ_ONLY_MODE, "true");
    assert.equal(cfg.planner.mcp_servers.jira.env.READ_ONLY_MODE, undefined);
    assert.equal(plain.mcpJira.mcpServers.jira.env.READ_ONLY_MODE, undefined);
    assert.equal(cfg.planner.mcp_servers.jira.env.REQUESTS_CA_BUNDLE, undefined);
    assert.equal(plain.mcpJira.mcpServers.jira.env.REQUESTS_CA_BUNDLE, undefined);
    assert.doesNotMatch(plain.teamEnv, /MPS_CA_BUNDLE/);

    const withCa = build((r) => { r.jira.ca_bundle = CA_FILE; });
    const caCfg = /** @type {any} */ (withCa.bridgeConfig);
    assert.equal(caCfg.planner.mcp_servers.jira.env.REQUESTS_CA_BUNDLE, CA_FILE);
    assert.equal(caCfg.orchestrators.SH.mcp_servers.jira.env.REQUESTS_CA_BUNDLE, CA_FILE);
    assert.equal(withCa.mcpJira.mcpServers.jira.env.REQUESTS_CA_BUNDLE, CA_FILE);
    assert.match(withCa.teamEnv, /^MPS_CA_BUNDLE=/m);
  });

  it("extra_args start with --append-system-prompt-file; --model only when set", () => {
    const plain = /** @type {any} */ (build().runnerConfig);
    for (const slot of plain.slots) {
      assert.equal(slot.extra_args[0], "--append-system-prompt-file");
      assert.equal(slot.extra_args[1], path.join(paths.generatedFlow, "sh-game.md"));
      assert.equal(slot.extra_args.includes("--model"), false);
      assert.deepEqual(slot.disallowed_tools, [...WORKER_DISALLOWED_TOOLS, ...workspaceSecretRules(paths)]);
      assert.deepEqual(slot.mcp_config_files, [paths.workerMcp]);
    }
    const withModel = /** @type {any} */ (build((r) => { r.models.worker = "sonnet"; }).runnerConfig);
    assert.deepEqual(withModel.slots[0].extra_args.slice(-2), ["--model", "sonnet"]);
  });

  it("numbers worker ids and worktree paths -01..-NN", () => {
    const files = build((r) => {
      r.repos[0].workers = 3;
      r.repos.push({ name: "sh-tools", path: REPO_B, project_key: "SH", base_branch: "main", workers: 1 });
    });
    const slots = /** @type {any} */ (files.runnerConfig).slots;
    assert.deepEqual(slots.map((s) => s.worker_id), ["w-sh-game-01", "w-sh-game-02", "w-sh-game-03", "w-sh-tools-01"]);
    assert.deepEqual(files.worktrees.map((w) => path.basename(w.wtPath)), ["sh-game-01", "sh-game-02", "sh-game-03", "sh-tools-01"]);
    assert.equal(files.worktrees[3].base, "main");
    assert.equal(/** @type {any} */ (files.bridgeConfig).max_concurrency, 4);
  });

  it("dedupes allowed_tools with order kept", () => {
    const files = build((r) => { r.repos[0].allowed_bash = ["npm test", "Bash(npm test)", "git:*"]; });
    const tools = /** @type {any} */ (files.runnerConfig).slots[0].allowed_tools;
    assert.deepEqual(tools, [
      "Read", "Grep", "Glob", "Edit", "Write", "Bash(git:*)", "Bash(npm test)",
      "mcp__jira__jira_get_issue", "mcp__jira__jira_add_comment",
    ]);
  });

  it("creates one orchestrator dir per project", () => {
    const files = build((r) => { r.projects.push("OPS"); });
    assert.deepEqual(files.dirs, [path.join(paths.orchestrators, "SH"), path.join(paths.orchestrators, "OPS")]);
    assert.deepEqual(Object.keys(/** @type {any} */ (files.bridgeConfig).orchestrators), ["SH", "OPS"]);
  });

  it("is deterministic", () => {
    assert.deepEqual(build(), build());
  });
});

describe("worktreeSpecs", () => {
  /** @param {(raw: any) => void} mutate */
  function settingsWith(mutate) {
    const raw = validRaw();
    mutate(raw);
    const r = validateSettings(raw, { workspace: WORKSPACE, appRoot: APP_ROOT_FAKE, fs: fakeFs() });
    assert.deepEqual(r.errors, []);
    return /** @type {any} */ (r.settings);
  }

  it("one spec per slot, repo by repo, without a token", () => {
    const settings = settingsWith((r) => {
      r.repos.push({ name: "sh-tools", path: REPO_B, project_key: "SH", base_branch: "main", workers: 1 });
    });
    assert.deepEqual(worktreeSpecs(settings, paths), [
      { repo: "sh-game", repoPath: settings.repos[0].path, wtPath: path.join(paths.worktrees, "sh-game-01"), base: "develop", workerId: "w-sh-game-01" },
      { repo: "sh-game", repoPath: settings.repos[0].path, wtPath: path.join(paths.worktrees, "sh-game-02"), base: "develop", workerId: "w-sh-game-02" },
      { repo: "sh-tools", repoPath: REPO_B, wtPath: path.join(paths.worktrees, "sh-tools-01"), base: "main", workerId: "w-sh-tools-01" },
    ]);
  });

  it("is what the runner config's slots are built from", () => {
    const settings = settingsWith((r) => { r.repos[0].workers = 3; });
    const specs = worktreeSpecs(settings, paths);
    const files = buildWorkspaceFiles(settings, paths, TOKEN);
    assert.deepEqual(files.worktrees, specs);
    const slots = /** @type {any} */ (files.runnerConfig).slots;
    assert.deepEqual(
      slots.map((s) => [s.worker_id, s.repo, s.worktree_path]),
      specs.map((s) => [s.workerId, s.repo, s.wtPath]),
    );
  });

  it("follows the effective worktrees root", () => {
    const moved = { ...paths, worktrees: path.join(path.parse(WORKSPACE).root, "wt") };
    const specs = worktreeSpecs(settingsWith(() => {}), moved);
    assert.deepEqual(specs.map((s) => s.wtPath), [path.join(moved.worktrees, "sh-game-01"), path.join(moved.worktrees, "sh-game-02")]);
  });
});

describe("helpers", () => {
  it("bashRule wraps plain commands and keeps Bash(...) entries", () => {
    assert.equal(bashRule("npm test"), "Bash(npm test)");
    assert.equal(bashRule(" dotnet build:* "), "Bash(dotnet build:*)");
    assert.equal(bashRule("Bash(make:*)"), "Bash(make:*)");
  });

  it("dotenvQuote escapes backslashes and double quotes", () => {
    assert.equal(dotenvQuote("D:\\certs\\new.pem"), '"D:\\\\certs\\\\new.pem"');
    assert.equal(dotenvQuote('a"b'), '"a\\"b"');
  });
});

describe("workspace secret deny rules (M2)", () => {
  it("permissionPath uses the //<drive>/ POSIX form verified on Claude Code 2.1.322", () => {
    assert.equal(permissionPath("D:" + String.fromCharCode(92) + "bridge" + String.fromCharCode(92) + "ws" + String.fromCharCode(92) + "settings.json"),
      "//d/bridge/ws/settings.json");
    assert.equal(permissionPath("C:/Users/Me/ws"), "//c/Users/Me/ws");
    assert.equal(permissionPath("/home/me/ws"), "//home/me/ws");
  });

  it("denies Read and Edit of the workspace secrets and the checkout's dev secrets for every slot", () => {
    const rules = workspaceSecretRules(paths);
    const root = permissionPath(WORKSPACE);
    const app = permissionPath(APP_ROOT_FAKE);
    const targets = [
      `${root}/settings.json`,
      `${root}/generated/**`,
      `${root}/data/**`,
      `${root}/logs/**`,
      `${app}/bridge.config.json`,
      `${app}/runner.config.json`,
      `${app}/.env`,
      `${app}/config/mcp/**`,
      `${app}/data/**`,
      `${app}/.env.*`,
    ];
    assert.deepEqual(rules, [...targets.map((t) => `Read(${t})`), ...targets.map((t) => `Edit(${t})`)]);
    assert.ok(!rules.some((r) => r.startsWith("Write(")), "Write(...) rules are ineffective on 2.1.322; Edit(...) covers Write");
    for (const slot of /** @type {any} */ (build().runnerConfig).slots) {
      for (const rule of rules) assert.ok(slot.disallowed_tools.includes(rule), rule);
    }
  });

  it("n4: denies a dev jira_env_file found in the checkout, in every slot", () => {
    const teamEnv = path.join(APP_ROOT_FAKE, "config", "team.env");
    const rules = workspaceSecretRules(paths, [teamEnv]);
    const target = permissionPath(teamEnv);
    assert.ok(rules.includes(`Read(${target})`) && rules.includes(`Edit(${target})`));
    const { settings } = validateSettings(validRaw(), { workspace: WORKSPACE, appRoot: APP_ROOT_FAKE, fs: fakeFs() });
    const files = buildWorkspaceFiles(/** @type {any} */ (settings), paths, TOKEN, [teamEnv]);
    for (const slot of /** @type {any} */ (files.runnerConfig).slots) {
      assert.ok(slot.disallowed_tools.includes(`Read(${target})`));
    }
    assert.ok(!workspaceSecretRules(paths).some((r) => r.includes("team.env")), "nothing extra by default");
  });

  it("the worker flow names the workspace it must stay out of", () => {
    assert.ok(build().workerFlows["sh-game"].includes(`\`${WORKSPACE}\``));
  });
});
