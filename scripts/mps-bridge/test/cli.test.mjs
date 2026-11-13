import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { workspacePaths } from "../lib/paths.mjs";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/** @param {string} cwd @param {...string} args */
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** @param {...string} args */
function cli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

describe("cli.mjs", () => {
  it("lists prepare in the usage and exits 1 on an unknown command", () => {
    const r = cli("bogus");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cách dùng: node cli\.mjs <init\|prepare\|start\|update> \[--workspace <thư mục>\]/);
    assert.match(r.stderr, /^ {2}prepare {2}/m);
  });

  describe("prepare", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mpsb-cli-"));
    const repo = path.join(dir, "repo");
    const ws = path.join(dir, "ws");
    const p = workspacePaths(ws);

    before(() => {
      const bare = path.join(dir, "origin.git");
      git(dir, "init", "--bare", "-b", "develop", bare);
      git(dir, "init", "-b", "develop", repo);
      git(repo, "config", "user.email", "t@example.com");
      git(repo, "config", "user.name", "t");
      writeFileSync(path.join(repo, "a.txt"), "a\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-m", "init");
      git(repo, "remote", "add", "origin", bare);
      git(repo, "push", "origin", "develop");
      mkdirSync(ws, { recursive: true });
      const settings = {
        jira: { url: "https://jira.example.com/", personal_token: "pat-123", ca_bundle: null },
        projects: ["SH"],
        repos: [{ name: "game", path: repo, project_key: "SH", base_branch: "develop", workers: 1, allowed_bash: [] }],
        models: { planner: null, orchestrator: null, worker: null },
        ports: { bridge: 8787, web: 4173 },
        max_concurrency: null,
        worktrees_dir: null,
      };
      writeFileSync(p.settings, JSON.stringify(settings, null, 2));
    });
    after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

    it("creates the worktrees with progress lines, and nothing that start needs (token, generated/)", () => {
      const r = cli("prepare", "--workspace", ws);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      const wt = path.join(p.worktrees, "game-01");
      assert.ok(r.stdout.includes("Đang fetch origin/develop cho repo game"), r.stdout);
      assert.ok(r.stdout.includes(`Đang tạo worktree ${wt} (1/1, có thể mất tới 10 phút)`), r.stdout);
      assert.ok(r.stdout.includes("Worktree đã sẵn sàng. Chạy start.cmd."), r.stdout);
      assert.ok(existsSync(path.join(wt, "a.txt")));
      assert.equal(existsSync(p.pairingTokenFile), false, "prepare does not create the pairing token");
      assert.equal(existsSync(p.generated), false, "prepare writes nothing to generated/");
      assert.equal(existsSync(path.join(p.data, "mps-bridge.lock")), false, "the lock is released on exit");
    });

    it("skips the creation on a second run", () => {
      const r = cli("prepare", "--workspace", ws);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.ok(r.stdout.includes("Worktree đã có sẵn (1), bỏ qua bước tạo."), r.stdout);
      assert.ok(!r.stdout.includes("Đang fetch"), r.stdout);
    });

    it("exits 2 when settings.json is invalid, before touching git", () => {
      const bad = path.join(dir, "ws-bad");
      mkdirSync(bad, { recursive: true });
      writeFileSync(path.join(bad, "settings.json"), "{ not json");
      const r = cli("prepare", "--workspace", bad);
      assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
      assert.ok(!existsSync(path.join(bad, "worktrees")));
    });
  });
});
