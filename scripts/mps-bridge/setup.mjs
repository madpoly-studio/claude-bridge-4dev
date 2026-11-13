#!/usr/bin/env node
// One-time bootstrap inside a git clone of claude-bridge: create the workspace (<clone>\ws by default), lock down its
// ACL, install and build the clone, then `cli.mjs init`. It never clones or pulls: the user just cloned, and updating
// is update.cmd's job. Only built-ins are imported statically, and only as default imports, so an old Node gets the
// version message instead of a crash while loading lib/ or binding a missing named export.
//
//   node <bản clone>\scripts\mps-bridge\setup.mjs [--workspace <thư mục>] [--ignore-old-install]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import util from "node:util";

/** Same value as lib/preflight.mjs MIN_NODE_MAJOR (checked before lib/ is imported). */
const MIN_NODE_MAJOR = 22;
const EXIT_RUNTIME = 1;
const EXIT_ENVIRONMENT = 3;
const USAGE = "Cách dùng: node setup.mjs [--workspace <thư mục>] [--ignore-old-install]";

/** @returns {Promise<number>} exit code */
async function main() {
  // First: util.parseArgs and lib/ need a recent Node.
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    console.error(`[LỖI] Cần Node.js >= ${MIN_NODE_MAJOR} (đang chạy ${process.version}).`);
    return EXIT_ENVIRONMENT;
  }
  let parsed;
  try {
    parsed = util.parseArgs({
      options: { workspace: { type: "string" }, "ignore-old-install": { type: "boolean" } },
      strict: true,
    });
  } catch (err) {
    console.error(`${/** @type {Error} */ (err).message}\n${USAGE}`);
    return EXIT_RUNTIME;
  }

  const [paths, { lockDownWorkspaceAcl }, { acquireWorkspaceLock }, appRepo, { which }, errors] = await Promise.all([
    import("./lib/paths.mjs"),
    import("./lib/acl.mjs"),
    import("./lib/lock.mjs"),
    import("./lib/app-repo.mjs"),
    import("./lib/proc.mjs"),
    import("./lib/errors.mjs"),
  ]);
  const { EXIT, UserError } = errors;
  const { assertWorkspaceLocation, oldInstallWorkspace, resolveWorkspace, workspacePaths } = paths;

  try {
    if (which("git") === null) {
      throw new UserError(
        "Không tìm thấy git trong PATH. Cài Git for Windows: https://git-scm.com/download/win rồi mở lại cửa sổ.",
        EXIT.ENVIRONMENT,
      );
    }
    const p = workspacePaths(resolveWorkspace(parsed.values.workspace));
    assertWorkspaceLocation(p.root, p.app);
    // This checkout may be the app\ of an install made before ws\ existed: a new <checkout>\ws would be a second
    // workspace (token, worktrees) next to the live one. Refused unless asked for explicitly.
    const oldWs = parsed.values.workspace === undefined ? oldInstallWorkspace(p.app) : null;
    if (oldWs !== null && parsed.values["ignore-old-install"] !== true) {
      throw new UserError(
        `Bản clone này là app\\ của bản cài cũ ${oldWs} (có settings.json và start.cmd). Chạy setup không có ` +
          `--workspace sẽ tạo thêm thư mục làm việc thứ hai ${p.root} bên cạnh bản đang chạy. ` +
          `Để cập nhật bản cài cũ: chạy ${oldWs}\\update.cmd, hoặc node "${p.cliEntry}" update --workspace "${oldWs}". ` +
          'Để chuyển sang bố cục mới: làm theo mục "Chuyển từ bản cài cũ" trong README. ' +
          "Nếu thật sự muốn tạo thư mục làm việc mới ở đây, chạy lại với --ignore-old-install.",
        EXIT.ENVIRONMENT,
      );
    }
    const existed = existsSync(p.root);
    mkdirSync(p.root, { recursive: true });
    // ACL only on a fresh (still empty) workspace, then always the lock, before any install: two setups started at
    // once must not both install and build. `cli init` takes no lock, so holding it across the spawn cannot deadlock.
    if (!existed) {
      const aclWarning = await lockDownWorkspaceAcl(p.root);
      if (aclWarning !== null) {
        console.log(`[CẢNH BÁO] ${aclWarning}`);
      }
    }
    acquireWorkspaceLock(p.data, "setup");

    console.log("Đang cài thư viện (pnpm install)…");
    if (!(await appRepo.installApp(p.app))) {
      throw new UserError("pnpm install thất bại. Xem lỗi ở trên rồi chạy lại setup.", EXIT.ENVIRONMENT);
    }
    console.log("Đang build…");
    if (!(await appRepo.buildApp(p.app))) {
      throw new UserError("Build thất bại. Xem lỗi ở trên rồi chạy lại setup.", EXIT.ENVIRONMENT);
    }

    const init = spawnSync(process.execPath, [p.cliEntry, "init", "--workspace", p.root], { stdio: "inherit" });
    if (init.status !== 0) {
      return init.status ?? EXIT.RUNTIME;
    }
    console.log("");
    console.log("Cài đặt xong. Các bước tiếp theo:");
    console.log(`  1. Mở ${p.settings} và điền mọi chỗ <...> (Jira token, project, repo).`);
    console.log(`  2. Chạy ${p.startCmd}.`);
    console.log(`  Hướng dẫn chi tiết: ${p.guide}`);
    return EXIT.OK;
  } catch (err) {
    if (err instanceof UserError) {
      console.error(`[LỖI] ${err.message}`);
      err.details.forEach((d, i) => console.error(`  ${i + 1}. ${d}`));
      return err.exitCode;
    }
    throw err;
  }
}

process.exitCode = await main();
