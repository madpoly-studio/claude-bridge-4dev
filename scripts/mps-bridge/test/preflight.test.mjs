import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { appDevSecretsWarning, appJiraEnvFile } from "../lib/preflight.mjs";

describe("appDevSecretsWarning (M1)", () => {
  const app = mkdtempSync(path.join(tmpdir(), "mpsb-app-secrets-"));
  after(() => rmSync(app, { recursive: true, force: true }));

  it("is silent for a checkout without dev secrets (the committed .env.example does not count)", () => {
    writeFileSync(path.join(app, ".env.example"), "A=1\n");
    assert.equal(appDevSecretsWarning(app), null);
  });

  it("names every dev secret file or folder present in the checkout", () => {
    writeFileSync(path.join(app, "bridge.config.json"), "{}");
    writeFileSync(path.join(app, ".env.local"), "A=1\n");
    mkdirSync(path.join(app, "data"));
    mkdirSync(path.join(app, "config", "mcp"), { recursive: true });
    const w = appDevSecretsWarning(app);
    assert.ok(w?.startsWith(`Bản clone bridge ${app} có file cấu hình/bí mật của chế độ dev (`), w ?? "");
    for (const rel of ["bridge.config.json", ".env.local", "data", path.join("config", "mcp")]) {
      assert.ok(w?.includes(path.join(app, rel)), rel);
    }
    assert.ok(!w?.includes("runner.config.json") && !w?.includes(".env.example"));
  });
});

describe("appJiraEnvFile (n4)", () => {
  const app = mkdtempSync(path.join(tmpdir(), "mpsb-app-jira-"));
  after(() => rmSync(app, { recursive: true, force: true }));
  const writeConfig = (text) => writeFileSync(path.join(app, "bridge.config.json"), text);

  it("null without a bridge.config.json", () => {
    assert.equal(appJiraEnvFile(app), null);
  });

  it("null, silently, for an unparsable bridge.config.json or one without jira_env_file", () => {
    writeConfig("{ not json");
    assert.equal(appJiraEnvFile(app), null);
    assert.equal(appDevSecretsWarning(app)?.includes("team.env") ?? false, false);
    writeConfig(JSON.stringify({ port: 8787 }));
    assert.equal(appJiraEnvFile(app), null);
  });

  it("resolves a relative path against the config's folder, like the backend, and warns when the file exists", () => {
    writeConfig(JSON.stringify({ jira_env_file: "config/team.env" }));
    const file = path.join(app, "config", "team.env");
    assert.equal(appJiraEnvFile(app), file);
    mkdirSync(path.join(app, "config"), { recursive: true });
    writeFileSync(file, "MPS_JIRA_PAT=x\n");
    assert.ok(appDevSecretsWarning(app)?.includes(file));
  });

  it("keeps an absolute path inside the checkout and ignores one outside it", () => {
    const inside = path.join(app, "secrets", "jira.env");
    writeConfig(JSON.stringify({ jira_env_file: inside }));
    assert.equal(appJiraEnvFile(app), inside);
    writeConfig(JSON.stringify({ jira_env_file: path.join(path.dirname(app), "team.env") }));
    assert.equal(appJiraEnvFile(app), null);
  });
});
