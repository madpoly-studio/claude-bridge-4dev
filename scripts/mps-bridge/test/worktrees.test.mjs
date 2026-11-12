import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { UserError } from "../lib/errors.mjs";
import { workspacePaths, worktreePath, workerId } from "../lib/paths.mjs";
import { ensureWorktrees } from "../lib/worktrees.mjs";

/** @param {string} cwd @param {...string} args */
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** @param {string} cwd @param {...string} args */
function gitMayFail(cwd, ...args) {
  try {
    git(cwd, ...args);
  } catch {
    // Expected (e.g. a merge conflict).
  }
}

describe("ensureWorktrees", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mpsb-wt-"));
  const bare = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  const p = workspacePaths(path.join(dir, "ws"));
  /** @param {number} n @param {string} [base] @param {string} [name] */
  const spec = (n, base = "develop", name = "game") => ({
    repo: name,
    repoPath: repo,
    wtPath: worktreePath(p, name, n),
    base,
    workerId: workerId(name, n),
  });

  before(() => {
    git(dir, "init", "--bare", "-b", "develop", bare);
    git(dir, "init", "-b", "develop", repo);
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "origin", "develop");
    mkdirSync(p.worktrees, { recursive: true });
  });
  after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

  it("creates missing worktrees, detached at origin/<base>", async () => {
    const report = await ensureWorktrees([spec(1), spec(2)], p);
    assert.deepEqual(report.created, [spec(1).wtPath, spec(2).wtPath]);
    assert.deepEqual(report.dirty, []);
    assert.equal(git(spec(1).wtPath, "rev-parse", "--abbrev-ref", "HEAD").trim(), "HEAD");
  });

  it("second run is a no-op", async () => {
    const report = await ensureWorktrees([spec(1), spec(2)], p);
    assert.deepEqual(report, { created: [], dirty: [], stashed: [], warnings: [] });
  });

  it("M4: stashes leftover work in a dirty worktree and detaches HEAD", async () => {
    const wt = spec(1).wtPath;
    git(wt, "checkout", "-b", "feature/SH-1-x");
    writeFileSync(path.join(wt, "a.txt"), "changed\n");
    writeFileSync(path.join(wt, "new.txt"), "untracked\n");
    const report = await ensureWorktrees([spec(1), spec(2)], p);
    assert.deepEqual(report.stashed, [wt]);
    assert.deepEqual(report.dirty, []);
    assert.ok(report.warnings.some((w) => w.includes('đã cất vào stash "mps-bridge auto-stash w-game-01 ')));
    assert.equal(git(wt, "status", "--porcelain").trim(), "");
    assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD").trim(), "HEAD");
    assert.match(git(wt, "stash", "list"), /mps-bridge auto-stash w-game-01 /);
    git(wt, "stash", "drop");
  });

  it("M4: a worktree that cannot be stashed (unmerged paths) is reported, not touched", async () => {
    const wt = spec(1).wtPath;
    git(wt, "checkout", "-B", "side", "origin/develop");
    writeFileSync(path.join(wt, "a.txt"), "side\n");
    git(wt, "commit", "-am", "side");
    git(wt, "checkout", "--detach", "origin/develop");
    writeFileSync(path.join(wt, "a.txt"), "other\n");
    git(wt, "commit", "-am", "other");
    gitMayFail(wt, "merge", "side");
    const report = await ensureWorktrees([spec(1), spec(2)], p);
    assert.deepEqual(report.dirty, [wt]);
    assert.ok(report.warnings.some((w) => w.includes("không tự stash được")));
    git(wt, "merge", "--abort");
    git(wt, "checkout", "--detach", "origin/develop");
  });

  it("WW2 for a leftover folder, matching the whole repo name", async () => {
    // Repo "game" must not claim "game-x-01": that folder belongs to a repo named "game-x".
    mkdirSync(path.join(p.worktrees, "game-x-01"), { recursive: true });
    try {
      const report = await ensureWorktrees([spec(1)], p);
      const leftover2 = report.warnings.find((w) => w.startsWith(`Worktree thừa ${spec(2).wtPath}`));
      const leftoverX = report.warnings.find((w) => w.startsWith(`Worktree thừa ${path.join(p.worktrees, "game-x-01")}`));
      assert.ok(leftover2?.includes(`git -C "${repo}" worktree remove`));
      assert.ok(leftoverX?.includes('git -C "<đường dẫn repo>"'), leftoverX);
    } finally {
      rmSync(path.join(p.worktrees, "game-x-01"), { recursive: true, force: true });
    }
  });

  it("W02 for a foreign folder", async () => {
    const foreign = spec(3);
    mkdirSync(foreign.wtPath, { recursive: true });
    try {
      await assert.rejects(ensureWorktrees([foreign], p), (err) =>
        err instanceof UserError && err.exitCode === 3 && err.details.some((d) => d.includes("không phải worktree của repo game")));
    } finally {
      rmSync(foreign.wtPath, { recursive: true, force: true });
    }
  });

  it("W01 when fetching the base fails", async () => {
    await assert.rejects(ensureWorktrees([spec(4, "nope")], p), (err) =>
      err instanceof UserError && err.details.some((d) => d.startsWith("git fetch origin nope cho repo game thất bại")));
  });

  it("W03 when the fetch succeeds but origin/<base> is not a branch", async () => {
    git(repo, "tag", "v1");
    git(repo, "push", "origin", "v1");
    await assert.rejects(ensureWorktrees([spec(4, "v1")], p), (err) =>
      err instanceof UserError && err.details.some((d) => d.startsWith("Không tìm thấy nhánh origin/v1 của repo game")));
  });

  it("m5: re-adds a registered worktree whose folder was deleted by hand (add --force, no repo-wide prune)", async () => {
    rmSync(spec(2).wtPath, { recursive: true, force: true });
    const report = await ensureWorktrees([spec(1), spec(2)], p);
    assert.deepEqual(report.created, [spec(2).wtPath]);
  });

  it("M7: warns when the repo's own checkout has uncommitted changes", async () => {
    writeFileSync(path.join(repo, "wip.txt"), "x");
    try {
      const report = await ensureWorktrees([spec(1), spec(2)], p);
      assert.ok(report.warnings.some((w) => w.startsWith("Repo game (") && w.includes("D:/bridge-repos/game")));
    } finally {
      rmSync(path.join(repo, "wip.txt"));
    }
  });

  it("M6: warns when origin/<base>:.claude/settings.json has allow rules or hooks", async () => {
    mkdirSync(path.join(repo, ".claude"), { recursive: true });
    writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(curl:*)"] } }));
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "claude settings");
    git(repo, "push", "origin", "develop");
    git(repo, "fetch", "origin");
    const report = await ensureWorktrees([spec(1), spec(2)], p);
    assert.ok(report.warnings.some((w) => w.startsWith('Repo game: .claude/settings.json trên origin/develop có "allow" hoặc "hooks"')));

    writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["WebFetch"] } }));
    git(repo, "commit", "-am", "deny only");
    git(repo, "push", "origin", "develop");
    git(repo, "fetch", "origin");
    const clean = await ensureWorktrees([spec(1), spec(2)], p);
    assert.ok(!clean.warnings.some((w) => w.includes(".claude/settings.json")));
  });
});
