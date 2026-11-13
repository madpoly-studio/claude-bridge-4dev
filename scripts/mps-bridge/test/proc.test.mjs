import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { UserError } from "../lib/errors.mjs";
import { BRIDGE_ENV_OVERRIDES, buildShellCommand, cleanChildEnv, run, which } from "../lib/proc.mjs";

const IS_WINDOWS = process.platform === "win32";
const BACKEND_CONFIG = fileURLToPath(new URL("../../../packages/backend/src/config.ts", import.meta.url));

describe("cleanChildEnv", () => {
  it("removes all 12 override keys (any case) and keeps the rest", () => {
    assert.equal(BRIDGE_ENV_OVERRIDES.length, 12);
    const base = Object.fromEntries(BRIDGE_ENV_OVERRIDES.map((k) => [k, "x"]));
    base.bridge_port = "1";
    base.PATH = "p";
    base.KEEP_ME = "k";
    assert.deepEqual(cleanChildEnv(base), { PATH: "p", KEEP_ME: "k" });
  });

  it("covers every env variable the backend config reads (parity with packages/backend/src/config.ts)", () => {
    const source = readFileSync(BACKEND_CONFIG, "utf8");
    // envOverrides' helpers int("X", …) / str("X", …), plus direct reads env.X / env["X"].
    const helperKeys = [...source.matchAll(/\b(?:int|str|bool)\(\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]);
    const directKeys = [...source.matchAll(/\benv(?:\.([A-Z][A-Z0-9_]*)|\[\s*"([A-Z][A-Z0-9_]*)"\s*\])/g)].map((m) => m[1] ?? m[2]);
    const read = new Set([...helperKeys, ...directKeys]);
    assert.ok(read.has("BRIDGE_PORT") && read.has("WAKE_MODE") && read.has("BRIDGE_CONFIG"), `parser found: ${[...read].join(", ")}`);
    const missing = [...read].filter((k) => !BRIDGE_ENV_OVERRIDES.includes(k));
    assert.deepEqual(missing, [], "add these to BRIDGE_ENV_OVERRIDES: a stray shell variable would override the generated config");
  });
});

describe("buildShellCommand", () => {
  it("quotes every part", () => {
    assert.equal(buildShellCommand("C:\\nodejs\\npx.cmd", ["-y", "pnpm@9.15.9"]), '"C:\\nodejs\\npx.cmd" "-y" "pnpm@9.15.9"');
  });

  for (const bad of ['a"b', "50%", "wow!", "a\nb", "a\rb"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => buildShellCommand("x.cmd", [bad]), UserError);
    });
  }
});

describe("which", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mpsb-which-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves through a fake PATH (and PATHEXT on Windows)", () => {
    if (IS_WINDOWS) {
      writeFileSync(path.join(dir, "tool"), "#!/bin/sh\n");
      writeFileSync(path.join(dir, "tool.cmd"), "@echo off\r\n");
      const env = { Path: `${path.join(dir, "missing")};${dir}`, PATHEXT: ".EXE;.CMD" };
      // NTFS is case-insensitive: the PATHEXT spelling (".CMD") is what comes back.
      assert.equal(which("tool", env)?.toLowerCase(), path.join(dir, "tool.cmd").toLowerCase(), "the extension-less POSIX script must be skipped");
      assert.equal(which("tool.cmd", env), path.join(dir, "tool.cmd"));
      assert.equal(which("tool", { Path: dir, PATHEXT: ".EXE" }), null);
    } else {
      const file = path.join(dir, "tool");
      writeFileSync(file, "#!/bin/sh\n");
      chmodSync(file, 0o755);
      assert.equal(which("tool", { PATH: `/nonexistent:${dir}` }), file);
    }
    assert.equal(which("definitely-not-a-command-xyz", { PATH: dir, PATHEXT: ".EXE" }), null);
  });
});

describe("run", () => {
  it("captures output and the exit code", async () => {
    const r = await run(process.execPath, ["-e", "console.log('hi'); process.exit(3)"]);
    assert.equal(r.code, 3);
    assert.equal(r.stdout.trim(), "hi");
    assert.equal(r.timedOut, false);
  });

  it("kills the process on timeout", async () => {
    const r = await run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 300 });
    assert.equal(r.timedOut, true);
  });

  it("throws UserError(3) for a missing command", async () => {
    await assert.rejects(run("definitely-not-a-command-xyz", []), (err) => err instanceof UserError && err.exitCode === 3);
  });
});
