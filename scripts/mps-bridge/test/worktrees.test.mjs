import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { UserError } from "../lib/errors.mjs";
import { workspacePaths, worktreePath, workerId } from "../lib/paths.mjs";
import { ancestorClaudeMdWarnings, ensureWorktrees } from "../lib/worktrees.mjs";

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
    // A CLAUDE.md above the temp folder on this machine is reported every time; anything else would be new.
    const baseline = ancestorClaudeMdWarnings([p.worktrees, p.root]);
    const report = await ensureWorktrees([spec(1), spec(2)], p);
    assert.deepEqual(report, { created: [], dirty: [], stashed: [], warnings: baseline });
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

  it("WW2 ignores folders under the worktrees root that are not slot folders", async () => {
    const notes = path.join(p.worktrees, "notes");
    mkdirSync(notes, { recursive: true });
    try {
      const report = await ensureWorktrees([spec(1), spec(2)], p);
      assert.ok(!report.warnings.some((w) => w.includes(notes)), report.warnings.join("\n"));
    } finally {
      rmSync(notes, { recursive: true, force: true });
    }
  });

  it("WW3 for a slot worktree registered outside the current root, naming the branch it holds", async () => {
    const oldWt = path.join(dir, "old-root", "game-01");
    git(repo, "worktree", "add", "-b", "feature/old", oldWt, "origin/develop");
    try {
      const report = await ensureWorktrees([spec(1), spec(2)], p);
      const w = report.warnings.find((x) => x.startsWith(`Worktree cũ ${oldWt} của repo game`));
      assert.ok(w, report.warnings.join("\n"));
      assert.ok(w.includes(`git -C "${repo}" worktree remove "${oldWt}"`));
      assert.ok(w.includes("Nó đang giữ nhánh feature/old"));
    } finally {
      git(repo, "worktree", "remove", "--force", oldWt);
      git(repo, "branch", "-D", "feature/old");
    }
  });

  it("WW3 for a registered slot whose folder was deleted and that no slot uses", async () => {
    const gone = worktreePath(p, "game", 7);
    git(repo, "worktree", "add", "--detach", gone, "origin/develop");
    rmSync(gone, { recursive: true, force: true });
    try {
      const report = await ensureWorktrees([spec(1), spec(2)], p);
      const w = report.warnings.find((x) => x.startsWith(`Repo game còn đăng ký worktree ${gone} nhưng thư mục đã bị xóa.`));
      assert.ok(w, report.warnings.join("\n"));
      assert.ok(w.includes(`git -C "${repo}" worktree prune`));
      assert.ok(!w.includes("đang giữ nhánh"), "detached: no branch note");
    } finally {
      git(repo, "worktree", "prune");
    }
  });

  it("WW4 when a worktree is created and the longest tracked path passes the limit (Windows only)", { skip: process.platform !== "win32" }, async () => {
    rmSync(spec(2).wtPath, { recursive: true, force: true });
    const report = await ensureWorktrees([spec(1), spec(2)], p, { longPathLimit: 10 });
    assert.deepEqual(report.created, [spec(2).wtPath]);
    const w = report.warnings.find((x) => x.startsWith("Repo game: đường dẫn file dài nhất trong worktree sẽ là "));
    // game-01 and game-02 have the same length: either may be named.
    assert.ok([spec(1), spec(2)].some((s) => w?.includes(`(${path.join(s.wtPath, "a.txt")})`)), report.warnings.join("\n"));
  });

  it("m5: WW4 is not repeated on a start that creates nothing (Windows only)", { skip: process.platform !== "win32" }, async () => {
    const quiet = await ensureWorktrees([spec(1), spec(2)], p, { longPathLimit: 10 });
    assert.deepEqual(quiet.created, []);
    assert.ok(!quiet.warnings.some((x) => x.includes("đường dẫn file dài nhất")), quiet.warnings.join("\n"));
  });

  it("n1: a failed add keeps the warnings, the long-path hint included, in the error (Windows only)", { skip: process.platform !== "win32" }, async () => {
    // A regular file where a folder is expected: fetch succeeds, "git worktree add" fails.
    const blocker = path.join(p.worktrees, "blocker");
    writeFileSync(blocker, "x");
    const bad = { repo: "game", repoPath: repo, wtPath: path.join(blocker, "game-09"), base: "develop", workerId: workerId("game", 9) };
    try {
      await assert.rejects(ensureWorktrees([spec(1), bad], p, { longPathLimit: 10 }), (err) => {
        assert.ok(err instanceof UserError && err.exitCode === 3);
        assert.ok(err.details.some((d) => d.startsWith(`Tạo worktree ${bad.wtPath} thất bại`)), err.details.join("\n"));
        assert.ok(
          err.details.some((d) => d.startsWith("[CẢNH BÁO] Repo game: đường dẫn file dài nhất trong worktree")),
          err.details.join("\n"),
        );
        return true;
      });
    } finally {
      rmSync(blocker, { force: true });
    }
  });

  it("WW6 when a repo with package.json gets worktrees inside the bridge checkout", async () => {
    writeFileSync(path.join(repo, "package.json"), "{}\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "js");
    git(repo, "push", "origin", "develop");
    // Same worktrees root, but with `dir` as the checkout: <dir>\ws\worktrees is inside it.
    const inside = workspacePaths(path.join(dir, "ws"), dir);
    const isWw6 = (w) => w.startsWith(`Repo game có package.json, còn worktree của worker nằm trong bản clone bridge ${dir}`);

    rmSync(spec(2).wtPath, { recursive: true, force: true });
    const created = await ensureWorktrees([spec(1), spec(2)], inside);
    assert.ok(created.warnings.some(isWw6), created.warnings.join("\n"));
    assert.ok(created.warnings.find(isWw6)?.includes("ví dụ D:/wt"));

    const again = await ensureWorktrees([spec(1), spec(2)], inside);
    assert.ok(!again.warnings.some(isWw6), "m5: only when a worktree was created");

    rmSync(spec(2).wtPath, { recursive: true, force: true });
    const outside = await ensureWorktrees([spec(1), spec(2)], p);
    assert.deepEqual(outside.created, [spec(2).wtPath]);
    assert.ok(!outside.warnings.some((w) => w.includes("có package.json")), "worktrees outside the checkout: no warning");
  });

  it("WW5 for a CLAUDE.md above the workspace", async () => {
    const file = path.join(dir, "CLAUDE.md");
    writeFileSync(file, "# project\n");
    try {
      const report = await ensureWorktrees([spec(1), spec(2)], p);
      assert.ok(report.warnings.some((w) => w.startsWith(`${file} nằm ở thư mục cha`)), report.warnings.join("\n"));
    } finally {
      rmSync(file);
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

describe("ancestorClaudeMdWarnings", () => {
  it("reports every instruction file in the start dirs and their parents, .claude\\CLAUDE.md of a parent home too", () => {
    // `home` stands for a home folder that is a parent of the bridge: its .claude\CLAUDE.md is a parent's file then.
    const home = mkdtempSync(path.join(tmpdir(), "mpsb-home-"));
    try {
      const ws = path.join(home, "bridge", "ws");
      mkdirSync(path.join(ws, "worktrees"), { recursive: true });
      mkdirSync(path.join(home, ".claude"), { recursive: true });
      writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "user memory\n");
      writeFileSync(path.join(home, "bridge", "CLAUDE.local.md"), "x\n");
      writeFileSync(path.join(ws, "CLAUDE.md"), "x\n");
      const mine = ancestorClaudeMdWarnings([path.join(ws, "worktrees"), ws], home).filter((w) => w.startsWith(home));
      assert.deepEqual(mine.map((w) => w.slice(0, w.indexOf(" "))), [
        path.join(ws, "CLAUDE.md"),
        path.join(home, "bridge", "CLAUDE.local.md"),
        path.join(home, ".claude", "CLAUDE.md"),
      ]);
      // n2: project files get "move/delete it"; the personal memory file must not, the bridge has to leave home.
      for (const w of mine.slice(0, 2)) {
        assert.ok(w.includes("nằm ở thư mục cha") && w.includes("Di chuyển/xóa nó"), w);
      }
      const memory = mine[2];
      assert.ok(memory.includes("là file hướng dẫn cá nhân của bạn"), memory);
      assert.ok(memory.includes(`ra ngoài ${home}`) && memory.includes("Đừng xóa file đó"), memory);
      assert.ok(!memory.includes("Di chuyển/xóa nó"), memory);
      // Without the home folder injected, the same file is just a parent's project file.
      const asProject = ancestorClaudeMdWarnings([ws], path.join(home, "someone-else"))
        .find((w) => w.startsWith(path.join(home, ".claude", "CLAUDE.md")));
      assert.ok(asProject?.includes("Di chuyển/xóa nó"), asProject);
      // A sibling folder that is not a parent is never looked at.
      assert.deepEqual(ancestorClaudeMdWarnings([path.join(home, "bridge")]).filter((w) => w.startsWith(ws)), []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
