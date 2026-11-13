#!/usr/bin/env node
// mps-bridge launcher: `init | start | update [--workspace <dir>]`. Orders the steps and maps errors to exit codes;
// every rule lives in lib/.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { lockDownWorkspaceAcl } from "./lib/acl.mjs";
import { buildApp, checkAppRepo, installApp, pullApp } from "./lib/app-repo.mjs";
import { EXIT, UserError } from "./lib/errors.mjs";
import { buildWorkspaceFiles } from "./lib/generate.mjs";
import { acquireWorkspaceLock } from "./lib/lock.mjs";
import { assertWorkspaceLocation, resolveWorkspace, withWorktreesRoot, workspacePaths } from "./lib/paths.mjs";
import { appDevSecretsWarning, appJiraEnvFile, checkPorts, checkTools, readPortsLoosely, warmUpJiraMcp } from "./lib/preflight.mjs";
import { cleanChildEnv } from "./lib/proc.mjs";
import {
  WEB_UI_DEFAULT_BRIDGE_PORT,
  missingSettingsMessage,
  parseSettingsFile,
  realFs,
  validateSettings,
} from "./lib/settings.mjs";
import { runSupervisor } from "./lib/supervisor.mjs";
import { distMissing, initWorkspace, pruneLogs, readOrCreatePairingToken, writeGenerated } from "./lib/workspace.mjs";
import { ensureWorktrees } from "./lib/worktrees.mjs";

const USAGE = "Cách dùng: node cli.mjs <init|start|update> [--workspace <thư mục>]";
const GRACEFUL_TIMEOUT_MS = 20_000;
const BACKEND_READY = Object.freeze({ timeoutMs: 60_000, intervalMs: 500 });
const WEB_READY = Object.freeze({ timeoutMs: 30_000, intervalMs: 500 });
const LOG_RETENTION_DAYS = 14;
const RULE = "=".repeat(60);

/**
 * @typedef {import("./lib/paths.mjs").WorkspacePaths} WorkspacePaths
 * @typedef {import("./lib/settings.mjs").Settings} Settings
 */

/** @param {string} line */
function warn(line) {
  console.log(`[CẢNH BÁO] ${line}`);
}

/**
 * @param {WorkspacePaths} p
 * @returns {Promise<number>}
 */
async function cmdInit(p) {
  const { createdSettings, createdToken } = initWorkspace(p);
  console.log(`Thư mục làm việc: ${p.root}`);
  console.log(`Mã nguồn bridge: ${p.app}`);
  console.log(createdSettings ? `  Đã tạo ${p.settings} (mẫu cần điền).` : `  Giữ nguyên ${p.settings}.`);
  console.log(createdToken ? `  Đã tạo pairing token: ${p.pairingTokenFile}` : "  Giữ nguyên pairing token.");
  console.log(`  Đã ghi ${p.startCmd}, ${p.updateCmd}, ${p.guide}`);
  const aclWarning = await lockDownWorkspaceAcl(p.root);
  if (aclWarning !== null) {
    warn(aclWarning);
  }
  console.log("");
  console.log(`Bước tiếp theo: mở ${p.settings}, điền mọi chỗ <...>, lưu lại rồi chạy start.cmd.`);
  return EXIT.OK;
}

/**
 * Steps 1-2 of start: parse + validate. No side effects.
 * @param {WorkspacePaths} p
 * @returns {Settings}
 */
function loadSettings(p) {
  if (!existsSync(p.settings)) {
    throw new UserError(missingSettingsMessage(p.settings), EXIT.SETTINGS);
  }
  const parsed = parseSettingsFile(p.settings);
  const result = parsed.ok
    ? validateSettings(parsed.raw, { workspace: p.root, appRoot: p.app, fs: realFs })
    : { errors: [parsed.error], warnings: [], settings: null };
  if (result.settings === null) {
    const lines = [`settings.json có ${result.errors.length} lỗi cần sửa (${p.settings}):`];
    result.errors.forEach((e, i) => lines.push(`  ${i + 1}. ${e}`));
    lines.push("Sửa xong lưu file rồi chạy lại start.cmd.");
    throw new UserError(lines.join("\n"), EXIT.SETTINGS);
  }
  result.warnings.forEach(warn);
  return result.settings;
}

/**
 * Builds the app when an output is missing (install first if even vite is missing).
 * @param {WorkspacePaths} p
 */
async function ensureBuilt(p) {
  const missing = distMissing(p);
  if (missing.length === 0) {
    return;
  }
  console.log(`Chưa có bản build (${missing.join(", ")}). Đang build, có thể mất vài phút…`);
  const installed = missing.includes(p.viteBin) ? await installApp(p.app) : true;
  if (installed) {
    await buildApp(p.app);
  }
  const still = distMissing(p);
  if (still.length > 0) {
    throw new UserError(`Chưa build xong (${still.join(", ")}) và build thất bại. Chạy update.cmd hoặc xem lỗi ở trên.`, EXIT.ENVIRONMENT);
  }
}

/**
 * @param {Settings} settings
 * @param {string} token
 */
function banner(settings, token) {
  const { bridge, web } = settings.ports;
  const lines = [
    RULE,
    " claude-bridge đang chạy",
    `   Giao diện    : http://127.0.0.1:${web}`,
  ];
  if (bridge !== WEB_UI_DEFAULT_BRIDGE_PORT) {
    lines.push(`   WebSocket URL: ws://127.0.0.1:${bridge}/ws   <- nhập URL này ở màn hình Kết nối (một lần)`);
  }
  lines.push(
    `   Pairing token: ${token}`,
    '   Lần đầu: dán token, tick "Ghi nhớ trên máy này", bấm Kết nối.',
    '   Dừng: Ctrl+C trong cửa sổ này (nếu hỏi "Terminate batch job (Y/N)?" gõ Y).',
    RULE,
  );
  return lines.join("\n");
}

/**
 * @param {WorkspacePaths} base
 * @returns {Promise<number>}
 */
async function cmdStart(base) {
  const settings = loadSettings(base);
  // Single source of the effective worktrees root for everything below (generated configs and worktree setup).
  const p = withWorktreesRoot(base, settings.worktrees_dir);
  // Held until this process exits: a second start/update must not rewrite generated/ under a live runner.
  acquireWorkspaceLock(p.data, "start");
  const devSecrets = appDevSecretsWarning(p.app);
  if (devSecrets !== null) {
    warn(devSecrets);
  }

  const portErrors = await checkPorts([
    { name: "bridge", port: settings.ports.bridge },
    { name: "web", port: settings.ports.web },
  ]);
  if (portErrors.length > 0) {
    throw new UserError("Không khởi động được:", EXIT.ENVIRONMENT, portErrors);
  }

  console.log("Đang kiểm tra công cụ (node, git, claude, uvx)…");
  const toolErrors = await checkTools(p, distMissing(p).length > 0);
  if (toolErrors.length > 0) {
    throw new UserError("Thiếu công cụ:", EXIT.ENVIRONMENT, toolErrors);
  }

  await ensureBuilt(p);

  console.log("Đang chuẩn bị mcp-atlassian (lần đầu có thể mất vài phút)…");
  const mcpWarning = await warmUpJiraMcp();
  if (mcpWarning !== null) {
    warn(mcpWarning);
  }

  const token = readOrCreatePairingToken(p);
  const devJiraEnv = appJiraEnvFile(p.app);
  const files = buildWorkspaceFiles(settings, p, token, devJiraEnv === null ? [] : [devJiraEnv]);
  writeGenerated(p, files);

  console.log("Đang chuẩn bị worktree cho worker…");
  try {
    mkdirSync(p.worktrees, { recursive: true });
  } catch (err) {
    throw new UserError(
      `Không tạo được thư mục worktree ${p.worktrees} (${/** @type {Error} */ (err).message}). Kiểm tra worktrees_dir trong settings.json.`,
      EXIT.ENVIRONMENT,
    );
  }
  const report = await ensureWorktrees(files.worktrees, p);
  report.created.forEach((wt) => console.log(`  Đã tạo worktree ${wt}`));
  report.warnings.forEach(warn);
  pruneLogs(p, LOG_RETENTION_DAYS);

  const env = cleanChildEnv();
  return runSupervisor({
    children: [
      {
        name: "backend",
        command: process.execPath,
        args: [p.backendEntry],
        cwd: p.root,
        env: { ...env, BRIDGE_CONFIG: p.bridgeConfig },
        ready: { url: `http://127.0.0.1:${settings.ports.bridge}/health`, ...BACKEND_READY },
      },
      {
        name: "runner",
        command: process.execPath,
        args: [p.runnerEntry, "--config", p.runnerConfig],
        cwd: p.root,
        env,
      },
      {
        name: "web",
        command: process.execPath,
        args: [p.viteBin, "preview", "--host", "127.0.0.1", "--port", String(settings.ports.web), "--strictPort"],
        cwd: p.webDir,
        env,
        ready: { url: `http://127.0.0.1:${settings.ports.web}/`, ...WEB_READY },
      },
    ],
    logsDir: p.logs,
    banner: () => banner(settings, token),
    gracefulTimeoutMs: GRACEFUL_TIMEOUT_MS,
  });
}

/**
 * @param {WorkspacePaths} p
 * @returns {Promise<number>}
 */
async function cmdUpdate(p) {
  acquireWorkspaceLock(p.data, "update");
  const ports = readPortsLoosely(p.settings);
  const busy = await checkPorts([
    { name: "bridge", port: ports.bridge },
    { name: "web", port: ports.web },
  ]);
  if (busy.length > 0) {
    throw new UserError(
      "Dịch vụ có vẻ đang chạy: hãy dừng dịch vụ trước (Ctrl+C ở cửa sổ start.cmd) rồi chạy lại update.cmd.",
      EXIT.ENVIRONMENT,
      busy,
    );
  }
  const repoErrors = await checkAppRepo(p.app);
  if (repoErrors.length > 0) {
    throw new UserError(`Không cập nhật được mã nguồn bridge (${p.app}):`, EXIT.ENVIRONMENT, repoErrors);
  }
  console.log("Đang tải bản mới (git pull)…");
  await pullApp(p.app);
  console.log("Đang cài thư viện (pnpm install)…");
  if (!(await installApp(p.app))) {
    throw new UserError("pnpm install thất bại. Xem lỗi ở trên.", EXIT.ENVIRONMENT);
  }
  console.log("Đang build…");
  if (!(await buildApp(p.app))) {
    throw new UserError("Build thất bại. Xem lỗi ở trên.", EXIT.ENVIRONMENT);
  }
  // Run the freshly pulled code so the launchers and guide come from the new version.
  const init = spawnSync(process.execPath, [p.cliEntry, "init", "--workspace", p.root], { stdio: "inherit" });
  if (init.status !== 0) {
    return init.status ?? EXIT.RUNTIME;
  }
  console.log("Đã cập nhật. Chạy start.cmd.");
  return EXIT.OK;
}

/** @returns {Promise<number>} */
async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options: { workspace: { type: "string" } }, allowPositionals: true, strict: true });
  } catch (err) {
    console.error(`${/** @type {Error} */ (err).message}\n${USAGE}`);
    return EXIT.RUNTIME;
  }
  const [command, ...extra] = parsed.positionals;
  if (extra.length > 0 || !["init", "start", "update"].includes(command)) {
    console.error(USAGE);
    return EXIT.RUNTIME;
  }
  const p = workspacePaths(resolveWorkspace(parsed.values.workspace));
  try {
    assertWorkspaceLocation(p.root, p.app);
    if (command === "init") {
      return await cmdInit(p);
    }
    if (command === "start") {
      return await cmdStart(p);
    }
    return await cmdUpdate(p);
  } catch (err) {
    if (err instanceof UserError) {
      console.error(`[LỖI] ${err.message}`);
      err.details.forEach((d, i) => console.error(`  ${i + 1}. ${d}`));
      return err.exitCode;
    }
    console.error("[LỖI] Lỗi không mong đợi (báo người bảo trì kèm nội dung dưới đây):");
    console.error(err);
    return EXIT.RUNTIME;
  }
}

const code = await main();
// Let buffered console output reach a piped stdout before exiting.
process.stdout.write("", () => process.exit(code));
