import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { checkAppRepo } from "../lib/app-repo.mjs";

/** @param {string} cwd @param {...string} args */
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("checkAppRepo (G01-G04)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mpsb-app-"));
  const bare = path.join(dir, "origin.git");
  const clone = path.join(dir, "clone");

  before(() => {
    git(dir, "init", "--bare", "-b", "main", bare);
    git(dir, "init", "-b", "main", clone);
    git(clone, "config", "user.email", "t@example.com");
    git(clone, "config", "user.name", "t");
    writeFileSync(path.join(clone, ".gitignore"), "/ws/\n");
    mkdirSync(path.join(clone, "copy", "scripts"), { recursive: true });
    writeFileSync(path.join(clone, "copy", "scripts", "cli.mjs"), "\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-m", "init");
    git(clone, "remote", "add", "origin", bare);
    git(clone, "push", "origin", "main");
  });
  after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

  it("a clean clone on main with origin may be updated, even with a workspace in ws\\", async () => {
    mkdirSync(path.join(clone, "ws", "data"), { recursive: true });
    writeFileSync(path.join(clone, "ws", "settings.json"), "{}");
    assert.deepEqual(await checkAppRepo(clone), []);
  });

  it("G02 when the clone has uncommitted changes", async () => {
    writeFileSync(path.join(clone, "wip.txt"), "x");
    try {
      const errors = await checkAppRepo(clone);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^Bản clone .* có thay đổi chưa commit/);
    } finally {
      rmSync(path.join(clone, "wip.txt"));
    }
  });

  it("G03 when the clone is on another branch", async () => {
    git(clone, "checkout", "-b", "dev");
    try {
      const errors = await checkAppRepo(clone);
      assert.equal(errors.length, 1);
      assert.ok(errors[0].includes("đang ở nhánh dev, cần main"), errors[0]);
    } finally {
      git(clone, "checkout", "main");
      git(clone, "branch", "-D", "dev");
    }
  });

  it("G04 when the clone has no origin remote", async () => {
    git(clone, "remote", "remove", "origin");
    try {
      const errors = await checkAppRepo(clone);
      assert.equal(errors.length, 1);
      assert.ok(errors[0].includes('chưa có remote "origin"'), errors[0]);
    } finally {
      git(clone, "remote", "add", "origin", bare);
    }
  });

  it("G01 for a folder without its own .git inside another repo: nothing else is checked, nothing pulled", async () => {
    const head = git(clone, "rev-parse", "HEAD");
    const errors = await checkAppRepo(path.join(clone, "copy"));
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("git đang dùng repo cha"), errors[0]);
    assert.equal(git(clone, "rev-parse", "HEAD"), head);
  });

  it("G01 when git cannot open the folder at all", async () => {
    const errors = await checkAppRepo(path.join(dir, "missing"));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^Mã nguồn bridge .* không phải git clone \(/);
  });
});
