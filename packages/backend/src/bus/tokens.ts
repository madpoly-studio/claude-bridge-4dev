// Token theo role (mục 7.6). Chỉ lưu hash SHA-256; so sánh bằng timingSafeEqual.
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomToken } from "../util/ids.js";

export const RUNNER_BOOTSTRAP_TOKEN_FILE = "runner-bootstrap.token";

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** So sánh hằng thời gian; độ dài khác nhau vẫn không rò rỉ nội dung (so trên hash). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function safeEqualHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Lấy token từ header `Authorization: Bearer <token>`; null nếu thiếu / sai dạng. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match ? (match[1] as string) : null;
}

/**
 * RUNNER_BOOTSTRAP_TOKEN: lấy từ cấu hình; nếu không có thì đọc `<data_dir>/runner-bootstrap.token`,
 * chưa có file thì sinh mới và ghi ra (runner cùng máy đọc file này).
 */
export function resolveRunnerBootstrapToken(configured: string | null, dataDir: string): string {
  if (configured) return configured;
  const file = join(dataDir, RUNNER_BOOTSTRAP_TOKEN_FILE);
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 16) return existing;
  }
  const token = randomToken();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

/** Token của bus: orchestrator (trong bộ nhớ, sinh mỗi lần khởi động) và bootstrap của runner. */
export class BusTokens {
  private readonly orchestratorToken = randomToken();

  constructor(private readonly runnerBootstrapToken: string) {}

  /** Đưa vào cấu hình MCP của session orchestrator (P10). */
  getOrchestratorToken(): string {
    return this.orchestratorToken;
  }

  isOrchestratorToken(token: string): boolean {
    return safeEqual(token, this.orchestratorToken);
  }

  isRunnerBootstrapToken(token: string): boolean {
    return safeEqual(token, this.runnerBootstrapToken);
  }
}
