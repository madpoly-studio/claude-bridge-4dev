// Client REST API v2 của Jira Server (chỉ đọc). Dùng node:https để truyền CA riêng theo request (fetch toàn cục
// của Node 22 không nhận CA theo request). Token chỉ nằm trong header, không bao giờ vào log hay thông báo lỗi.
import http from "node:http";
import https from "node:https";
import { rootCertificates } from "node:tls";
import type { JiraSettings } from "./jiraSettings.js";

const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
/** Trần số trang để một JQL sai không kéo vô hạn. */
const MAX_PAGES = 20;
/** Độ dài tối đa phần body đưa vào thông báo lỗi. */
const ERROR_BODY_CHARS = 300;

export class JiraHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JiraHttpError";
  }
}

export interface JiraIssue {
  key: string;
  fields: Record<string, unknown>;
}

interface SearchPage {
  startAt?: number;
  total?: number;
  issues?: JiraIssue[];
}

export class JiraClient {
  private readonly agent: https.Agent | undefined;

  constructor(private readonly settings: JiraSettings) {
    // `ca` thay thế CA mặc định, nên gộp thêm rootCertificates để host công khai vẫn xác thực được.
    this.agent = settings.ca ? new https.Agent({ ca: [...rootCertificates, settings.ca.toString("utf8")], keepAlive: true }) : undefined;
  }

  /** Mọi issue khớp JQL (phân trang theo startAt / total). */
  async searchAll(jql: string, fields: readonly string[]): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = (await this.get("/rest/api/2/search", {
        jql,
        fields: fields.join(","),
        startAt: String(issues.length),
        maxResults: String(PAGE_SIZE),
      })) as SearchPage;
      const batch = Array.isArray(body.issues) ? body.issues : [];
      issues.push(...batch);
      const total = typeof body.total === "number" ? body.total : issues.length;
      if (batch.length === 0 || issues.length >= total) return issues;
    }
    return issues;
  }

  close(): void {
    this.agent?.destroy();
  }

  private get(path: string, query: Record<string, string>): Promise<unknown> {
    const url = new URL(`${this.settings.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const isHttps = url.protocol === "https:";
    const options: https.RequestOptions = {
      method: "GET",
      headers: { Authorization: `Bearer ${this.settings.token}`, Accept: "application/json" },
      timeout: REQUEST_TIMEOUT_MS,
      ...(isHttps && this.agent ? { agent: this.agent } : {}),
    };
    return new Promise((resolve, reject) => {
      const req = (isHttps ? https : http).request(url, options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new JiraHttpError(status, `GET ${url.pathname} returned HTTP ${status}: ${text.slice(0, ERROR_BODY_CHARS)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as unknown);
          } catch {
            reject(new Error(`GET ${url.pathname} returned invalid JSON`));
          }
        });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error(`GET ${url.pathname} timed out after ${REQUEST_TIMEOUT_MS} ms`)));
      req.on("error", reject);
      req.end();
    });
  }
}
