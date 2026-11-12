import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { workspacePaths } from "../lib/paths.mjs";
import { parseSettingsFile } from "../lib/settings.mjs";
import { distMissing, initWorkspace, pruneLogs, readOrCreatePairingToken, writeGenerated } from "../lib/workspace.mjs";

const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));

function tempWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "mpsb-ws-"));
  // The templates normally live in app/; point at the ones in this checkout.
  return { ...workspacePaths(root), templatesDir: TEMPLATES };
}

describe("initWorkspace", () => {
  const p = tempWorkspace();
  after(() => rmSync(p.root, { recursive: true, force: true }));

  it("creates the layout, settings.json and the token on first run", async () => {
    const first = await initWorkspace(p);
    assert.deepEqual(first, { createdSettings: true, createdToken: true });
    for (const dir of [p.app, p.generatedMcp, p.generatedFlow, p.data, p.orchestrators, p.worktrees, p.logs]) {
      assert.ok(existsSync(dir), dir);
    }
    const parsed = parseSettingsFile(p.settings);
    assert.equal(parsed.ok, true, "the template must be valid JSON");
    assert.match(readOrCreatePairingToken(p), /^[A-Za-z0-9_-]{32}$/);
  });

  it("is idempotent and never overwrites settings.json or the token", async () => {
    writeFileSync(p.settings, '{"mine": true}');
    const token = readOrCreatePairingToken(p);
    const second = await initWorkspace(p);
    assert.deepEqual(second, { createdSettings: false, createdToken: false });
    assert.equal(readFileSync(p.settings, "utf8"), '{"mine": true}');
    assert.equal(readOrCreatePairingToken(p), token);
  });

  it("writes .cmd launchers as CRLF, pure ASCII, starting in their own folder", () => {
    for (const file of [p.startCmd, p.updateCmd]) {
      const bytes = readFileSync(file);
      assert.ok(bytes.every((b) => b < 0x80), `${file} must be ASCII`);
      const text = bytes.toString("ascii");
      assert.equal(text.split("\n").length - 1, text.split("\r\n").length - 1, `${file} must be CRLF only`);
      assert.ok(text.includes('cd /d "%~dp0"'));
    }
    assert.ok(readFileSync(p.startCmd, "ascii").includes("cli.mjs start"));
    assert.ok(readFileSync(p.updateCmd, "ascii").includes("cli.mjs update"));
  });

  it("writes HUONG-DAN.txt as UTF-8 with BOM and CRLF, workspace substituted", () => {
    const bytes = readFileSync(p.guide);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    assert.ok(text.includes(p.root));
    assert.ok(!text.includes("{{WORKSPACE}}"));
    assert.ok(!/[^\r]\n/.test(text), "every LF must follow a CR");
  });

  it("m2: update.cmd runs everything after the update from one block with delayed expansion", () => {
    const text = readFileSync(p.updateCmd, "ascii");
    assert.ok(text.includes("setlocal EnableDelayedExpansion"));
    const block = text.slice(text.indexOf("(" + String.fromCharCode(13, 10)));
    assert.ok(block.includes("cli.mjs update"), "the node call is inside the block");
    assert.ok(block.includes('set "RC=!ERRORLEVEL!"') && block.includes("exit /b !RC!"));
    assert.ok(!block.includes("%RC%") && !block.includes("%ERRORLEVEL%"), "no parse-time expansion inside the block");
    assert.ok(text.trimEnd().endsWith(")"));
  });

  it("m2: launchers are not rewritten when their content is unchanged", () => {
    const old = new Date("2020-01-01T00:00:00Z");
    for (const f of [p.startCmd, p.updateCmd, p.guide]) utimesSync(f, old, old);
    initWorkspace(p);
    for (const f of [p.startCmd, p.updateCmd, p.guide]) {
      assert.equal(statSync(f).mtime.getTime(), old.getTime(), `${f} was rewritten`);
    }
    writeFileSync(p.updateCmd, "stale");
    initWorkspace(p);
    assert.ok(readFileSync(p.updateCmd, "ascii").includes("cli.mjs update"), "a changed launcher is refreshed");
  });

  it("rejects a corrupt token file", () => {
    writeFileSync(p.pairingTokenFile, "short\n");
    assert.throws(() => readOrCreatePairingToken(p), /bị hỏng/);
  });
});

describe("writeGenerated", () => {
  const p = tempWorkspace();
  after(() => rmSync(p.root, { recursive: true, force: true }));

  it("wipes stale files and writes every derived file", () => {
    const files = {
      bridgeConfig: { port: 1 },
      runnerConfig: { slots: [] },
      teamEnv: "A=\"1\"\n",
      mcpJira: { mcpServers: { jira: { command: "uvx", args: [], env: {} } } },
      workerFlows: { "sh-game": "# flow\n" },
      dirs: [path.join(p.orchestrators, "SH")],
      worktrees: [],
    };
    writeGenerated(p, files);
    const stale = path.join(p.generatedFlow, "old-repo.md");
    writeFileSync(stale, "stale");
    writeGenerated(p, files);
    assert.equal(existsSync(stale), false);
    assert.deepEqual(JSON.parse(readFileSync(p.bridgeConfig, "utf8")), { port: 1 });
    assert.deepEqual(JSON.parse(readFileSync(p.workerMcp, "utf8")), files.mcpJira);
    assert.equal(readFileSync(p.teamEnv, "utf8"), files.teamEnv);
    assert.equal(readFileSync(path.join(p.generatedFlow, "sh-game.md"), "utf8"), "# flow\n");
    assert.ok(existsSync(path.join(p.orchestrators, "SH")));
  });

  it("distMissing lists absent build outputs", () => {
    assert.deepEqual(distMissing(p), [p.protocolEntry, p.backendEntry, p.runnerEntry, p.webDistIndex, p.viteBin]);
  });
});

describe("pruneLogs (m11)", () => {
  const p = tempWorkspace();
  after(() => rmSync(p.root, { recursive: true, force: true }));

  it("deletes dated logs older than the retention window and keeps the rest", () => {
    mkdirSync(p.logs, { recursive: true });
    const names = ["backend-20261020.log", "runner-20261028.log", "web-20261029.log", "supervisor-20261112.log", "notes.txt"];
    for (const n of names) writeFileSync(path.join(p.logs, n), "x");
    const deleted = pruneLogs(p, 14, new Date(2026, 10, 12, 9, 0, 0));
    assert.deepEqual(deleted.sort(), ["backend-20261020.log", "runner-20261028.log"]);
    assert.deepEqual(readdirSync(p.logs).sort(), ["notes.txt", "supervisor-20261112.log", "web-20261029.log"]);
  });
});
