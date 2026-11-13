import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { UserError } from "../lib/errors.mjs";
import { APP_ROOT, workspacePaths } from "../lib/paths.mjs";
import { parseSettingsFile, validateSettings } from "../lib/settings.mjs";
import {
  distMissing,
  initWorkspace,
  launcherCliEntry,
  pruneLogs,
  readOrCreatePairingToken,
  writeGenerated,
} from "../lib/workspace.mjs";
import { APP_ROOT_FAKE, REPO_A, WORKSPACE, abs, fakeFs } from "./helpers.mjs";

const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));

function tempWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "mpsb-ws-"));
  // A fake, empty app root keeps distMissing independent of whether this checkout is built; the templates come from
  // this checkout.
  return { ...workspacePaths(root, path.join(root, "app")), templatesDir: TEMPLATES };
}

describe("initWorkspace", () => {
  const p = tempWorkspace();
  after(() => rmSync(p.root, { recursive: true, force: true }));

  it("creates the layout, settings.json and the token on first run", async () => {
    const first = await initWorkspace(p);
    assert.deepEqual(first, { createdSettings: true, createdToken: true });
    for (const dir of [p.generatedMcp, p.generatedFlow, p.data, p.orchestrators, p.worktrees, p.logs]) {
      assert.ok(existsSync(dir), dir);
    }
    assert.equal(existsSync(p.app), false, "init never creates the app folder: the checkout is the app");
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
    for (const file of [p.startCmd, p.prepareCmd, p.updateCmd]) {
      const bytes = readFileSync(file);
      assert.ok(bytes.every((b) => b < 0x80), `${file} must be ASCII`);
      const text = bytes.toString("ascii");
      assert.equal(text.split("\n").length - 1, text.split("\r\n").length - 1, `${file} must be CRLF only`);
      assert.ok(text.includes('cd /d "%~dp0"'));
    }
    // tempWorkspace puts the fake app inside the workspace, like an install made before ws\ existed.
    const entry = `node "%~dp0${path.join("app", "scripts", "mps-bridge", "cli.mjs")}"`;
    assert.ok(readFileSync(p.startCmd, "ascii").includes(`${entry} start --workspace "%~dp0."`));
    assert.ok(readFileSync(p.updateCmd, "ascii").includes(`${entry} update --workspace "%~dp0."`));
    assert.ok(!readFileSync(p.startCmd, "ascii").includes("{{"));
  });

  it("writes prepare.cmd: runs `prepare` on its own folder and always pauses so the result stays readable", () => {
    const text = readFileSync(p.prepareCmd, "ascii");
    const entry = `node "%~dp0${path.join("app", "scripts", "mps-bridge", "cli.mjs")}"`;
    assert.ok(text.includes(`${entry} prepare --workspace "%~dp0."`));
    assert.ok(!text.includes("{{"));
    const lines = text.split("\r\n");
    const pauseAt = lines.findIndex((l) => l.trim() === "pause");
    assert.ok(pauseAt !== -1 && !/^\s/.test(lines[pauseAt]), "an unconditional pause, outside the if blocks");
    assert.equal(lines[pauseAt + 1], "exit /b %RC%");
  });

  it("update brings prepare.cmd to an install that only had start.cmd and update.cmd", () => {
    rmSync(p.prepareCmd);
    initWorkspace(p);
    assert.ok(readFileSync(p.prepareCmd, "ascii").includes('cli.mjs" prepare'));
  });

  it("writes HUONG-DAN.txt as UTF-8 with BOM and CRLF, workspace and app root substituted", () => {
    const bytes = readFileSync(p.guide);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    assert.ok(text.includes(p.root));
    assert.ok(text.includes(`Mã nguồn bridge: ${p.app} `));
    assert.ok(!text.includes("{{"));
    assert.ok(!/[^\r]\n/.test(text), "every LF must follow a CR");
  });

  it("m2: update.cmd runs everything after the update from one block with delayed expansion", () => {
    const text = readFileSync(p.updateCmd, "ascii");
    assert.ok(text.includes("setlocal EnableDelayedExpansion"));
    const block = text.slice(text.indexOf("(" + String.fromCharCode(13, 10)));
    assert.ok(block.includes('cli.mjs" update'), "the node call is inside the block");
    assert.ok(block.includes('set "RC=!ERRORLEVEL!"') && block.includes("exit /b !RC!"));
    assert.ok(!block.includes("%RC%") && !block.includes("%ERRORLEVEL%"), "no parse-time expansion inside the block");
    assert.ok(text.trimEnd().endsWith(")"));
  });

  it("m2: launchers are not rewritten when their content is unchanged", () => {
    const old = new Date("2020-01-01T00:00:00Z");
    for (const f of [p.startCmd, p.prepareCmd, p.updateCmd, p.guide]) utimesSync(f, old, old);
    initWorkspace(p);
    for (const f of [p.startCmd, p.prepareCmd, p.updateCmd, p.guide]) {
      assert.equal(statSync(f).mtime.getTime(), old.getTime(), `${f} was rewritten`);
    }
    writeFileSync(p.updateCmd, "stale");
    initWorkspace(p);
    assert.ok(readFileSync(p.updateCmd, "ascii").includes('cli.mjs" update'), "a changed launcher is refreshed");
  });

  it("rejects a corrupt token file", () => {
    writeFileSync(p.pairingTokenFile, "short\n");
    assert.throws(() => readOrCreatePairingToken(p), /bị hỏng/);
  });
});

describe("settings template", () => {
  it("with the placeholders filled it passes validation and keeps the default worktrees root", () => {
    const parsed = parseSettingsFile(path.join(TEMPLATES, "settings.template.json"));
    assert.equal(parsed.ok, true);
    const raw = /** @type {any} */ (parsed.ok ? parsed.raw : null);
    raw.jira.personal_token = "pat-123";
    raw.projects = ["SH"];
    raw.repos[0] = { ...raw.repos[0], name: "sh-game", path: REPO_A, project_key: "SH", base_branch: "develop" };
    const r = validateSettings(raw, { workspace: WORKSPACE, appRoot: APP_ROOT_FAKE, fs: fakeFs() });
    assert.deepEqual(r.errors, []);
    assert.equal(r.settings?.worktrees_dir, null);
  });
});

describe("launcherCliEntry", () => {
  const cli = (appRoot) => path.join(appRoot, "scripts", "mps-bridge", "cli.mjs");

  it("default layout: relative to <clone>\\ws", () => {
    const app = abs("clone");
    assert.equal(launcherCliEntry(path.join(app, "ws"), cli(app)), `"%~dp0${path.join("..", "scripts", "mps-bridge", "cli.mjs")}"`);
  });

  it("old install: relative to the workspace that holds app\\", () => {
    const ws = abs("old-bridge");
    assert.equal(launcherCliEntry(ws, cli(path.join(ws, "app"))), `"%~dp0${path.join("app", "scripts", "mps-bridge", "cli.mjs")}"`);
  });

  it("a non-ASCII parent folder is fine: only the relative part is written", () => {
    const app = abs("Dự án", "clone");
    assert.equal(launcherCliEntry(path.join(app, "ws"), cli(app)), `"%~dp0${path.join("..", "scripts", "mps-bridge", "cli.mjs")}"`);
  });

  it("L2 when the written part is not ASCII or has a cmd.exe special character", () => {
    const ws = abs("bridge", "ws");
    for (const app of [abs("bridge", "công-cụ"), abs("bridge", "a&b"), abs("bridge", "50%")]) {
      assert.throws(() => launcherCliEntry(ws, cli(app)), (err) =>
        err instanceof UserError && err.exitCode === 3 && err.message.includes("đường dẫn tới cli.mjs"));
    }
  });

  it('L1 when the workspace path has "!" (update.cmd uses delayed expansion), in every layout', () => {
    const app = abs("wow!", "clone");
    assert.throws(() => launcherCliEntry(path.join(app, "ws"), cli(app)), (err) =>
      err instanceof UserError && err.message.includes('có ký tự "!"'));
  });

  it("m1: a workspace reached through a junction/symlink gets the absolute form (%~dp0 is not resolved)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mpsb-link-"));
    try {
      const real = path.join(dir, "clone");
      mkdirSync(path.join(real, "ws"), { recursive: true });
      const link = path.join(dir, "link");
      symlinkSync(real, link, "junction");
      assert.equal(launcherCliEntry(path.join(link, "ws"), cli(link)), `"${cli(link)}"`);
      assert.equal(
        launcherCliEntry(path.join(real, "ws"), cli(real)),
        `"%~dp0${path.join("..", "scripts", "mps-bridge", "cli.mjs")}"`,
        "the same folder without the link stays relative",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("another volume: absolute, still guarded", { skip: process.platform !== "win32" }, () => {
    const here = path.parse(APP_ROOT).root.slice(0, 1).toUpperCase();
    const other = here === "Q" ? "R" : "Q";
    const app = abs("clone");
    assert.equal(launcherCliEntry(`${other}:\\ws`, cli(app)), `"${cli(app)}"`);
    assert.throws(() => launcherCliEntry(`${other}:\\ws`, cli(abs("công-cụ"))), /đường dẫn tới cli\.mjs/);
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
