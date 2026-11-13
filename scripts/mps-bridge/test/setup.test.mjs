import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { LOCK_FILE_NAME } from "../lib/lock.mjs";
import { MIN_NODE_MAJOR } from "../lib/preflight.mjs";

const SETUP = fileURLToPath(new URL("../setup.mjs", import.meta.url));

describe("setup.mjs", () => {
  it("prints the usage and exits 1 on an unknown option, before touching anything", () => {
    const r = spawnSync(process.execPath, [SETUP, "--bogus"], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cách dùng: node setup\.mjs \[--workspace <thư mục>\] \[--ignore-old-install\]/);
  });

  it("checks the same minimum Node version as preflight (its own copy: it runs before lib/ is loaded)", () => {
    const m = /^const MIN_NODE_MAJOR = (\d+);$/m.exec(readFileSync(SETUP, "utf8"));
    assert.equal(Number(m?.[1]), MIN_NODE_MAJOR);
  });

  it("m3: no named import from node:util, and the version check comes before parseArgs", () => {
    const text = readFileSync(SETUP, "utf8");
    assert.doesNotMatch(text, /import \{[^}]*\} from "node:util"/);
    const check = text.indexOf("if (major < MIN_NODE_MAJOR)");
    assert.ok(check !== -1 && check < text.indexOf("util.parseArgs("));
  });

  it("never clones or pulls: the clone it lives in is the app", () => {
    const text = readFileSync(SETUP, "utf8");
    assert.doesNotMatch(text, /"clone"|"pull"|APP_REPO_URL/);
  });

  it("m6: exits 3 with the lock-busy message, before any install, while another process holds the workspace", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "mpsb-setup-"));
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      mkdirSync(path.join(ws, "data"));
      const lock = { pid: holder.pid, command: "start", started: new Date().toISOString() };
      writeFileSync(path.join(ws, "data", LOCK_FILE_NAME), JSON.stringify(lock));
      // spawn (not spawnSync): the holder must stay alive while setup runs.
      const r = await new Promise((resolve) => {
        const child = spawn(process.execPath, [SETUP, "--workspace", ws], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      assert.equal(r.status, 3, r.stderr);
      assert.ok(r.stderr.includes(`Thư mục làm việc đang được dùng bởi tiến trình ${holder.pid} ("start"`), r.stderr);
      assert.ok(!r.stdout.includes("pnpm install"), "no install was attempted");
    } finally {
      holder.kill();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
