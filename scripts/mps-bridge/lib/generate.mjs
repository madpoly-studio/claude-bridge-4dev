// Pure projection settings → every config file the packages read. No IO: workspace.mjs writes the result.
import path from "node:path";
import { workerId, worktreePath } from "./paths.mjs";
import { renderWorkerFlow } from "./worker-flow.mjs";

export const PLANNER_ALLOWED_TOOLS = Object.freeze(["mcp__jira__jira_search", "mcp__jira__jira_get_*"]);
export const WORKER_BASE_TOOLS = Object.freeze(["Read", "Grep", "Glob", "Edit", "Write", "Bash(git:*)"]);
export const WORKER_JIRA_TOOLS = Object.freeze(["mcp__jira__jira_get_issue", "mcp__jira__jira_add_comment"]);
export const WORKER_DISALLOWED_TOOLS = Object.freeze([
  "Bash(git push --force:*)",
  "Bash(git push -f:*)",
  "Bash(git push --force-with-lease:*)",
  "Bash(git push --delete:*)",
  "Bash(git push origin --delete:*)",
  "WebFetch",
]);

const LOOPBACK = "127.0.0.1";
const AGENT_LABEL = "agent";
const CLAUDE_AUTH_MODE = "subscription";
const JIRA_MCP_COMMAND = "uvx";
// TODO(mps-bridge): mcp-atlassian is unpinned (uvx resolves the latest release on each cold cache); pin a version
// once the team settles on one. HUONG-DAN.txt mentions it.
const JIRA_MCP_ARGS = Object.freeze(["mcp-atlassian"]);
const WORKER_PERMISSION_MODE = "dontAsk";
const TEAM_ENV_HEADER = "# Sinh tự động từ settings.json bởi mps-bridge. KHÔNG sửa tay: bị ghi đè mỗi lần start.";

/**
 * @typedef {import("./settings.mjs").Settings} Settings
 * @typedef {import("./paths.mjs").WorkspacePaths} WorkspacePaths
 * @typedef {{ command: string, args: string[], env: Record<string, string> }} StdioMcpServer
 * @typedef {{ repo: string, repoPath: string, wtPath: string, base: string, workerId: string }} WorktreeSpec
 * @typedef {Record<string, unknown>} BridgeConfigJson
 * @typedef {Record<string, unknown>} RunnerConfigJson
 */

/**
 * @typedef {object} WorkspaceFiles
 * @property {BridgeConfigJson} bridgeConfig
 * @property {RunnerConfigJson} runnerConfig
 * @property {string} teamEnv dotenv text
 * @property {{ mcpServers: { jira: StdioMcpServer } }} mcpJira
 * @property {Record<string, string>} workerFlows repo name → markdown
 * @property {string[]} dirs absolute directories to create (orchestrator cwd per project)
 * @property {WorktreeSpec[]} worktrees
 */

/**
 * "npm test" → "Bash(npm test)"; an entry already in Bash(...) form is kept.
 * @param {string} entry
 */
export function bashRule(entry) {
  const trimmed = entry.trim();
  return /^Bash\(.*\)$/.test(trimmed) ? trimmed : `Bash(${trimmed})`;
}

/**
 * Absolute path in Claude Code permission-rule form: "D:\mps\x" → "//d/mps/x", "/home/x" → "//home/x".
 * Verified on Claude Code 2.1.322 (headless probes): Windows rules use this POSIX form and match case-insensitively.
 * @param {string} absPath
 */
export function permissionPath(absPath) {
  const posix = absPath.replace(/\\/g, "/");
  if (posix.startsWith("//")) {
    return posix;
  }
  const drive = /^([A-Za-z]):\//.exec(posix);
  return drive === null ? `/${posix}` : `//${drive[1].toLowerCase()}${posix.slice(2)}`;
}

/**
 * Secrets of the developer workflow (README "Cấu hình") that may sit, gitignored, in the bridge checkout. Workers run
 * below it in the default layout (<checkout>\ws\worktrees), so the checkout is one of their parent folders.
 * Relative to the checkout root, "/" separated.
 */
export const APP_DEV_SECRET_FILES = Object.freeze(["bridge.config.json", "runner.config.json", ".env"]);
export const APP_DEV_SECRET_DIRS = Object.freeze(["config/mcp", "data"]);
/** ".env.local", ".env.production", …: the gitignore ignores ".env.*". */
export const APP_DEV_ENV_PREFIX = ".env.";

/**
 * Deny rules that keep workers away from the workspace secrets (Jira PAT in settings.json and generated/, tokens in
 * data/ and logs/) and from the developer-workflow secrets in the bridge checkout. Read(...) also covers Grep/Glob;
 * Edit(...) covers every file-writing tool. Write(...) rules are not used: on 2.1.322 they did not stop the Write
 * tool, while Edit(...) did.
 * @param {WorkspacePaths} paths
 * @param {string[]} [appSecretFiles] more absolute secret files in the checkout (the dev jira_env_file, read by
 *   preflight.mjs appJiraEnvFile: this module stays a pure projection)
 * @returns {string[]}
 */
export function workspaceSecretRules(paths, appSecretFiles = []) {
  const app = permissionPath(paths.app);
  const targets = [
    permissionPath(paths.settings),
    `${permissionPath(paths.generated)}/**`,
    `${permissionPath(paths.data)}/**`,
    `${permissionPath(paths.logs)}/**`,
    ...APP_DEV_SECRET_FILES.map((f) => `${app}/${f}`),
    ...APP_DEV_SECRET_DIRS.map((d) => `${app}/${d}/**`),
    `${app}/${APP_DEV_ENV_PREFIX}*`,
    ...appSecretFiles.map(permissionPath),
  ];
  return ["Read", "Edit"].flatMap((tool) => targets.map((t) => `${tool}(${t})`));
}

/**
 * Double-quoted dotenv value. The backend parser unescapes \n \r \t \" \\ inside double quotes,
 * so a Windows path like D:\certs\new.pem must have its backslashes doubled.
 * @param {string} value
 */
export function dotenvQuote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * @param {Settings["jira"]} jira
 * @returns {Record<string, string>}
 */
function jiraEnv(jira) {
  /** @type {Record<string, string>} */
  const env = {
    JIRA_URL: jira.url,
    JIRA_PERSONAL_TOKEN: jira.personal_token,
    JIRA_SSL_VERIFY: "true",
  };
  if (jira.ca_bundle !== null) {
    env.REQUESTS_CA_BUNDLE = jira.ca_bundle;
  }
  return env;
}

/**
 * @param {Record<string, string>} env
 * @returns {StdioMcpServer}
 */
function jiraServer(env) {
  return { command: JIRA_MCP_COMMAND, args: [...JIRA_MCP_ARGS], env };
}

/**
 * @param {Settings} settings
 */
function buildTeamEnv(settings) {
  const lines = [
    TEAM_ENV_HEADER,
    `MPS_JIRA_URL=${dotenvQuote(settings.jira.url)}`,
    `MPS_JIRA_PAT=${dotenvQuote(settings.jira.personal_token)}`,
    `MPS_JIRA_PROJECT_KEY=${dotenvQuote(settings.projects[0])}`,
  ];
  if (settings.jira.ca_bundle !== null) {
    lines.push(`MPS_CA_BUNDLE=${dotenvQuote(settings.jira.ca_bundle)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {Settings} settings
 * @param {WorkspacePaths} paths
 * @param {string} pairingToken
 * @returns {BridgeConfigJson}
 */
function buildBridgeConfig(settings, paths, pairingToken) {
  const env = jiraEnv(settings.jira);
  /** @type {Record<string, unknown>} */
  const orchestrators = {};
  for (const key of settings.projects) {
    orchestrators[key] = {
      cwd: path.join(paths.orchestrators, key),
      mcp_servers: { jira: jiraServer({ ...env, READ_ONLY_MODE: "true" }) },
      allowed_tools: [...PLANNER_ALLOWED_TOOLS],
      system_prompt_append: null,
      model: settings.models.orchestrator,
      setting_sources: ["project"],
    };
  }
  const web = settings.ports.web;
  return {
    port: settings.ports.bridge,
    data_dir: paths.data,
    allowed_origins: [`http://${LOOPBACK}:${web}`, `http://localhost:${web}`],
    repos: settings.repos.map((r) => ({ name: r.name, path: r.path, project_key: r.project_key })),
    projects: [...settings.projects],
    max_concurrency: settings.max_concurrency,
    agent_label: AGENT_LABEL,
    claude_auth_mode: CLAUDE_AUTH_MODE,
    jira_env_file: paths.teamEnv,
    planner: {
      // The planner gets no READ_ONLY_MODE: its create tool is not in allowed_tools, so it goes through approval.
      mcp_servers: { jira: jiraServer({ ...env }) },
      allowed_tools: [...PLANNER_ALLOWED_TOOLS],
      system_prompt_append: null,
      model: settings.models.planner,
      setting_sources: [],
    },
    orchestrators,
    orchestrator_autostart: true,
    pairing_token: pairingToken,
  };
}

/**
 * One worktree per worker slot, in slot order. The single source of the slot list: the runner config is built from
 * it, and `prepare` uses it alone (no token, nothing generated).
 * @param {Settings} settings validated settings
 * @param {WorkspacePaths} paths effective paths (paths.worktrees is the worktrees root)
 * @returns {WorktreeSpec[]}
 */
export function worktreeSpecs(settings, paths) {
  /** @type {WorktreeSpec[]} */
  const specs = [];
  for (const repo of settings.repos) {
    for (let n = 1; n <= repo.workers; n++) {
      specs.push({
        repo: repo.name,
        repoPath: repo.path,
        wtPath: worktreePath(paths, repo.name, n),
        base: repo.base_branch,
        workerId: workerId(repo.name, n),
      });
    }
  }
  return specs;
}

/**
 * @param {Settings} settings
 * @param {WorkspacePaths} paths
 * @param {string[]} appSecretFiles
 * @returns {{ runnerConfig: RunnerConfigJson, worktrees: WorktreeSpec[] }}
 */
function buildRunnerConfig(settings, paths, appSecretFiles) {
  const disallowed = [...WORKER_DISALLOWED_TOOLS, ...workspaceSecretRules(paths, appSecretFiles)];
  /** @type {Map<string, { allowed: string[], extraArgs: string[] }>} */
  const perRepo = new Map();
  for (const repo of settings.repos) {
    perRepo.set(repo.name, {
      allowed: [...new Set([...WORKER_BASE_TOOLS, ...repo.allowed_bash.map(bashRule), ...WORKER_JIRA_TOOLS])],
      extraArgs: [
        "--append-system-prompt-file",
        path.join(paths.generatedFlow, `${repo.name}.md`),
        "--setting-sources",
        "project",
        ...(settings.models.worker === null ? [] : ["--model", settings.models.worker]),
      ],
    });
  }
  const worktrees = worktreeSpecs(settings, paths);
  const slots = worktrees.map((spec) => {
    const { allowed, extraArgs } = /** @type {{ allowed: string[], extraArgs: string[] }} */ (perRepo.get(spec.repo));
    return {
      worker_id: spec.workerId,
      repo: spec.repo,
      worktree_path: spec.wtPath,
      allowed_tools: [...allowed],
      disallowed_tools: [...disallowed],
      extra_args: [...extraArgs],
      mcp_config_files: [paths.workerMcp],
      env: {},
      permission_mode: WORKER_PERMISSION_MODE,
    };
  });
  return {
    runnerConfig: {
      bus_url: `http://${LOOPBACK}:${settings.ports.bridge}`,
      bootstrap_token_file: paths.runnerBootstrapTokenFile,
      claude_command: ["claude"],
      slots,
    },
    worktrees,
  };
}

/**
 * @param {Settings} settings validated settings
 * @param {WorkspacePaths} paths
 * @param {string} pairingToken
 * @param {string[]} [appSecretFiles] see workspaceSecretRules
 * @returns {WorkspaceFiles}
 */
export function buildWorkspaceFiles(settings, paths, pairingToken, appSecretFiles = []) {
  const { runnerConfig, worktrees } = buildRunnerConfig(settings, paths, appSecretFiles);
  /** @type {Record<string, string>} */
  const workerFlows = {};
  for (const repo of settings.repos) {
    workerFlows[repo.name] = renderWorkerFlow({
      repo: repo.name,
      projectKey: repo.project_key,
      baseBranch: repo.base_branch,
      testCommands: [...repo.allowed_bash],
      workspace: paths.root,
    });
  }
  return {
    bridgeConfig: buildBridgeConfig(settings, paths, pairingToken),
    runnerConfig,
    teamEnv: buildTeamEnv(settings),
    mcpJira: { mcpServers: { jira: jiraServer(jiraEnv(settings.jira)) } },
    workerFlows,
    dirs: settings.projects.map((key) => path.join(paths.orchestrators, key)),
    worktrees,
  };
}
