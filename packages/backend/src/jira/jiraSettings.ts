// Cấu hình Jira Reader (quyết định I3) đọc từ file `.env` có sẵn của team: MPS_JIRA_URL, MPS_JIRA_PAT,
// MPS_JIRA_PROJECT_KEY, MPS_CA_BUNDLE (đường dẫn CA, có thể tương đối theo thư mục của file .env).
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const JIRA_ENV = {
  URL: "MPS_JIRA_URL",
  PAT: "MPS_JIRA_PAT",
  PROJECT_KEY: "MPS_JIRA_PROJECT_KEY",
  CA_BUNDLE: "MPS_CA_BUNDLE",
} as const;

export interface JiraSettings {
  /** Không có dấu `/` cuối. */
  baseUrl: string;
  /** Personal Access Token. Không bao giờ ghi log. */
  token: string;
  /** Nội dung PEM của CA bundle, null = CA mặc định của Node. */
  ca: Buffer | null;
  /** Project key mặc định trong .env (dùng khi cấu hình bridge không có `projects`). */
  projectKey: string | null;
}

export type JiraSettingsResult =
  | { status: "ok"; settings: JiraSettings }
  | { status: "unconfigured"; reason: string }
  | { status: "error"; reason: string };

/**
 * Parser dotenv tối giản (không thêm dependency): `KEY=VALUE`, tiền tố `export`, comment `#`,
 * giá trị trong nháy đơn (giữ nguyên) hoặc nháy kép (hỗ trợ \n, \", \\).
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    let value = (match[2] as string).trim();
    if (value.startsWith('"')) {
      const end = findClosingQuote(value);
      value = value
        .slice(1, end === -1 ? undefined : end)
        .replace(/\\(n|r|t|"|\\)/g, (_m, c: string) => ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" })[c] ?? c);
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = value.slice(1, end === -1 ? undefined : end);
    } else {
      // Comment cuối dòng chỉ khi có khoảng trắng trước `#` (giữ được URL có fragment).
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function findClosingQuote(value: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "\\") i++;
    else if (value[i] === '"') return i;
  }
  return -1;
}

/** Đọc file .env; thiếu file / biến → `unconfigured`, file CA không đọc được → `error`. */
export function loadJiraSettings(envFile: string | null): JiraSettingsResult {
  if (envFile === null) return { status: "unconfigured", reason: "jira_env_file is not set" };
  if (!existsSync(envFile)) return { status: "unconfigured", reason: `jira_env_file ${envFile} does not exist` };
  let vars: Record<string, string>;
  try {
    vars = parseDotenv(readFileSync(envFile, "utf8"));
  } catch (err) {
    return { status: "error", reason: `cannot read ${envFile}: ${(err as Error).message}` };
  }
  const baseUrl = vars[JIRA_ENV.URL]?.trim();
  const token = vars[JIRA_ENV.PAT]?.trim();
  if (!baseUrl || !token) {
    return { status: "unconfigured", reason: `${envFile} must define ${JIRA_ENV.URL} and ${JIRA_ENV.PAT}` };
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("not http(s)");
  } catch {
    return { status: "error", reason: `${JIRA_ENV.URL} is not a valid http(s) URL` };
  }
  let ca: Buffer | null = null;
  const caPath = vars[JIRA_ENV.CA_BUNDLE]?.trim();
  if (caPath) {
    const abs = isAbsolute(caPath) ? caPath : resolve(dirname(envFile), caPath);
    try {
      ca = readFileSync(abs);
    } catch (err) {
      return { status: "error", reason: `cannot read ${JIRA_ENV.CA_BUNDLE} ${abs}: ${(err as Error).message}` };
    }
  }
  return {
    status: "ok",
    settings: {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      token,
      ca,
      projectKey: vars[JIRA_ENV.PROJECT_KEY]?.trim() || null,
    },
  };
}
