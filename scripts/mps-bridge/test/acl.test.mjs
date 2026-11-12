import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { lockDownWorkspaceAcl } from "../lib/acl.mjs";

/** @param {string} exe */
const sys32 = (exe) => path.join(process.env.SystemRoot ?? "C:/Windows", "System32", exe);

describe("lockDownWorkspaceAcl (M5)", { skip: process.platform !== "win32" }, () => {
  it("removes inherited entries, grants the user/SYSTEM/Administrators, and is idempotent", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mpsb-acl-"));
    try {
      writeFileSync(path.join(dir, "settings.json"), "{}");
      assert.match(execFileSync(sys32("icacls.exe"), [dir], { encoding: "utf8" }), /\(I\)/, "a fresh temp dir inherits its ACL");
      assert.equal(await lockDownWorkspaceAcl(dir), null);
      const sid = /S-1-[0-9-]+/.exec(execFileSync(sys32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }))?.[0];
      const acl = execFileSync(sys32("icacls.exe"), [dir], { encoding: "utf8" });
      assert.doesNotMatch(acl.split(/\r?\n/)[0], /\(I\)/, "the root entry is no longer inherited");
      assert.doesNotMatch(acl, /\(I\)/);
      const listSids =
        `(Get-Acl -LiteralPath '${dir}').Access | ` +
        "ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }";
      const sids = execFileSync("powershell", ["-NoProfile", "-Command", listSids], { encoding: "utf8" });
      for (const expected of [sid, "S-1-5-18", "S-1-5-32-544"]) {
        assert.ok(sids.includes(expected), `${expected} missing in\n${sids}`);
      }
      assert.equal(sids.trim().split(/\r?\n/).length, 3, sids);
      // Files created later inherit the protected ACL.
      const child = execFileSync(sys32("icacls.exe"), [path.join(dir, "settings.json")], { encoding: "utf8" });
      assert.match(child, /\(I\)/);
      assert.equal(await lockDownWorkspaceAcl(dir), null, "second run is a no-op");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
