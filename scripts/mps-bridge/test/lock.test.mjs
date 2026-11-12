import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { UserError } from "../lib/errors.mjs";
import { LOCK_FILE_NAME, acquireWorkspaceLock, isProcessAlive } from "../lib/lock.mjs";

describe("workspace lock (M3)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mpsb-lock-"));
  const file = path.join(dir, LOCK_FILE_NAME);
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("writes our PID and removes the file on release", () => {
    const release = acquireWorkspaceLock(dir, "start");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, process.pid);
    release();
    assert.equal(existsSync(file), false);
  });

  it("refuses while another live process holds it", async () => {
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      writeFileSync(file, JSON.stringify({ pid: holder.pid, command: "start", started: "2026-01-01T00:00:00Z" }));
      assert.throws(() => acquireWorkspaceLock(dir, "update"), (err) =>
        err instanceof UserError && err.exitCode === 3 && err.message.includes(`tiến trình ${holder.pid} ("start"`));
      assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, holder.pid, "a live holder's lock is left alone");
    } finally {
      holder.kill();
      rmSync(file, { force: true });
    }
  });

  it("replaces a stale lock left by a dead process", () => {
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const deadPid = Number(dead.stdout);
    assert.equal(isProcessAlive(deadPid), false);
    writeFileSync(file, JSON.stringify({ pid: deadPid, command: "start", started: "x" }));
    const release = acquireWorkspaceLock(dir, "start");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, process.pid);
    release();
  });

  it("replaces an unreadable lock file", () => {
    writeFileSync(file, "garbage");
    const release = acquireWorkspaceLock(dir, "start");
    release();
    assert.equal(existsSync(file), false);
  });
});
