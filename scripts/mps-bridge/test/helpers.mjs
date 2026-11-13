// Shared test helpers: platform-absolute paths, a fake FsProbe and a valid baseline settings object.
import path from "node:path";

const DRIVE_ROOT = path.parse(process.cwd()).root;

/** Absolute path on the current platform ("D:\\repos\\x" on Windows, "/repos/x" elsewhere). */
export function abs(...parts) {
  return path.resolve(DRIVE_ROOT, ...parts);
}

/** A bridge checkout that is not this one: containment rules must not depend on where the tests run. */
export const APP_ROOT_FAKE = abs("bridge-app");
export const WORKSPACE = abs("bridge-app", "ws");
export const REPO_A = abs("repos", "sh-game");
export const REPO_B = abs("repos", "sh-tools");
export const CA_FILE = abs("certs", "corp.pem");

/**
 * @param {{ dirs?: string[], files?: string[] }} [extra]
 * @returns {import("../lib/settings.mjs").FsProbe}
 */
export function fakeFs(extra = {}) {
  const key = (p) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const dirs = new Set([REPO_A, REPO_B, ...(extra.dirs ?? [])].map(key));
  const files = new Set([path.join(REPO_A, ".git"), path.join(REPO_B, ".git"), CA_FILE, ...(extra.files ?? [])].map(key));
  return {
    isDir: (p) => dirs.has(key(p)),
    isFile: (p) => files.has(key(p)),
    exists: (p) => dirs.has(key(p)) || files.has(key(p)),
    canonical: (p) => path.resolve(p),
  };
}

/** A complete, valid settings object (guidance keys already stripped). */
export function validRaw() {
  return {
    jira: { url: "https://jira.example.com/", personal_token: "pat-123", ca_bundle: null },
    projects: ["SH"],
    repos: [
      { name: "sh-game", path: REPO_A, project_key: "SH", base_branch: "develop", workers: 2, allowed_bash: ["npm test"] },
    ],
    models: { planner: null, orchestrator: null, worker: null },
    ports: { bridge: 8787, web: 4173 },
    max_concurrency: null,
  };
}
