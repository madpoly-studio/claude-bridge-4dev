import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { UserError } from "../lib/errors.mjs";
import {
  APP_ROOT,
  WORKSPACE_DIR_NAME,
  assertWorkspaceLocation,
  oldInstallWorkspace,
  resolveWorkspace,
  samePath,
  withWorktreesRoot,
  workspacePaths,
} from "../lib/paths.mjs";
import { abs } from "./helpers.mjs";

describe("assertWorkspaceLocation (M2)", () => {
  const clone = abs("bridge-clone");
  const refused = (root) =>
    assert.throws(() => assertWorkspaceLocation(root, clone), (err) =>
      err instanceof UserError && err.exitCode === 3 && err.message.includes(`ngoài ${path.join(clone, "ws")}`));

  it("refuses the checkout itself and any folder in it outside ws\\", () => {
    refused(clone);
    refused(path.join(clone, "myws"));
    refused(path.join(clone, "packages", "ws"));
  });

  it("accepts <checkout>\\ws (and below), an install's workspace that holds the checkout, and anything outside", () => {
    assertWorkspaceLocation(path.join(clone, "ws"), clone);
    assertWorkspaceLocation(path.join(clone, "ws", "sub"), clone);
    assertWorkspaceLocation(abs(), path.join(abs("old-bridge"), "app"));
    assertWorkspaceLocation(abs("old-bridge"), path.join(abs("old-bridge"), "app"));
    assertWorkspaceLocation(abs("elsewhere", "ws"), clone);
    assertWorkspaceLocation(`${clone}-ws`, clone);
  });

  it("compares case-insensitively on Windows", { skip: process.platform !== "win32" }, () => {
    refused(path.join(clone.toUpperCase(), "MYWS"));
    assertWorkspaceLocation(path.join(clone.toUpperCase(), "WS"), clone);
  });
});

describe("oldInstallWorkspace (m2)", () => {
  it("finds the workspace of an install made before ws\\ existed only when settings.json and start.cmd are both there", () => {
    const old = mkdtempSync(path.join(tmpdir(), "mpsb-old-"));
    try {
      const app = path.join(old, "app");
      mkdirSync(app);
      assert.equal(oldInstallWorkspace(app), null);
      writeFileSync(path.join(old, "settings.json"), "{}");
      assert.equal(oldInstallWorkspace(app), null);
      writeFileSync(path.join(old, "start.cmd"), "@echo off");
      assert.equal(oldInstallWorkspace(app), old);
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  });
});

describe("APP_ROOT and the default workspace", () => {
  it("APP_ROOT is the bridge checkout, without a trailing separator", () => {
    assert.ok(existsSync(path.join(APP_ROOT, "pnpm-workspace.yaml")));
    assert.ok(existsSync(path.join(APP_ROOT, "scripts", "mps-bridge", "cli.mjs")));
    assert.equal(APP_ROOT, path.resolve(APP_ROOT));
  });

  it("the workspace defaults to <APP_ROOT>\\ws; --workspace overrides it", () => {
    assert.equal(resolveWorkspace(undefined), path.join(APP_ROOT, WORKSPACE_DIR_NAME));
    assert.equal(resolveWorkspace(abs("elsewhere", "ws")), abs("elsewhere", "ws"));
  });

  it("app paths come from the app root, everything else from the workspace", () => {
    const ws = abs("tmp", "ws");
    const p = workspacePaths(ws);
    assert.equal(p.app, APP_ROOT);
    assert.equal(p.cliEntry, path.join(APP_ROOT, "scripts", "mps-bridge", "cli.mjs"));
    assert.equal(p.settings, path.join(ws, "settings.json"));
    assert.equal(p.worktrees, path.join(ws, "worktrees"));
    const fake = workspacePaths(ws, abs("fake-app"));
    assert.equal(fake.backendEntry, abs("fake-app", "packages", "backend", "dist", "index.js"));
  });

  it("withWorktreesRoot replaces only the worktrees root", () => {
    const p = workspacePaths(abs("tmp", "ws"));
    assert.equal(withWorktreesRoot(p, null), p);
    const moved = withWorktreesRoot(p, abs("wt"));
    assert.equal(moved.worktrees, abs("wt"));
    assert.deepEqual({ ...moved, worktrees: p.worktrees }, p);
  });

  it("samePath compares both directions", () => {
    assert.equal(samePath(abs("a", "b"), abs("a", "b")), true);
    assert.equal(samePath(abs("a"), abs("a", "b")), false);
    if (process.platform === "win32") {
      assert.equal(samePath(abs("A", "B"), abs("a", "b")), true);
    }
  });

  const isGitCheckout = existsSync(path.join(APP_ROOT, ".git"));
  it("ws/ is ignored by git at the checkout root", { skip: !isGitCheckout }, () => {
    for (const file of ["ws/settings.json", "ws/worktrees/x-01/a"]) {
      const r = spawnSync("git", ["-C", APP_ROOT, "check-ignore", "-q", file], { encoding: "utf8" });
      assert.equal(r.status, 0, `${file}: ${r.stderr}`);
    }
  });

  it("the checkout root has no project CLAUDE.md: it would leak into every worker below <APP_ROOT>\\ws\\worktrees", () => {
    for (const name of ["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")]) {
      assert.equal(existsSync(path.join(APP_ROOT, name)), false, name);
    }
  });
});
