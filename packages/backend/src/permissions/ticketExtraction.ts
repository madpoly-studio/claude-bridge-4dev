// Lấy ticket_key từ kết quả tool tạo issue và labels từ input đã duyệt (mục 5.3 bước 5).
// Không phụ thuộc MCP server Jira cụ thể: ưu tiên field `key` / `issueKey` trong JSON, sau đó regex khóa Jira.
import { JIRA_KEY_RE } from "@claude-bridge/protocol";

const FULL_KEY_RE = new RegExp(`^${JIRA_KEY_RE.source.replace(/\\b/g, "")}$`);
const GLOBAL_KEY_RE = new RegExp(JIRA_KEY_RE.source, "g");
const KEY_FIELDS = ["key", "issueKey", "issue_key"] as const;
/** Giới hạn độ sâu khi tìm field key trong JSON kết quả. */
const MAX_JSON_DEPTH = 4;

/** Text của `tool_result.content`: chuỗi, hoặc mảng block `{type:"text", text}`. */
export function toolResultTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts;
}

/**
 * `sources`: các text của tool_result và (nếu có) kết quả có cấu trúc. `projectKey`: project trong input tạo issue,
 * dùng để chọn đúng khóa khi văn bản có nhiều chuỗi giống khóa Jira (ví dụ `UTF-8`).
 */
export function extractTicketKey(sources: readonly unknown[], projectKey: string | null): string | null {
  for (const source of sources) {
    const parsed = typeof source === "string" ? tryParseJson(source) : source;
    const fromJson = findKeyField(parsed, 0);
    if (fromJson) return fromJson;
  }
  const candidates: string[] = [];
  for (const source of sources) {
    const text = typeof source === "string" ? source : JSON.stringify(source ?? null);
    for (const match of text.matchAll(GLOBAL_KEY_RE)) candidates.push(match[1] as string);
  }
  if (projectKey) {
    const preferred = candidates.find((k) => k.startsWith(`${projectKey}-`));
    if (preferred) return preferred;
  }
  return candidates[0] ?? null;
}

/** labels từ `labels`, `fields.labels` hoặc `additional_fields.labels` (object hoặc chuỗi JSON, như mcp-atlassian). */
export function extractLabels(input: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string" && v.trim() !== "") out.add(v.trim());
    } else if (typeof value === "string") {
      for (const v of value.split(",")) if (v.trim() !== "") out.add(v.trim());
    }
  };
  add(input.labels);
  if (isRecord(input.fields)) add(input.fields.labels);
  const additional = typeof input.additional_fields === "string" ? tryParseJson(input.additional_fields) : input.additional_fields;
  if (isRecord(additional)) add(additional.labels);
  return [...out];
}

/** Project key trong input tạo issue: `project_key`, `projectKey`, `project` (chuỗi hoặc `{key}`), `fields.project.key`. */
export function extractProjectKey(input: Record<string, unknown>): string | null {
  const candidates: unknown[] = [input.project_key, input.projectKey, input.project];
  if (isRecord(input.project)) candidates.push(input.project.key);
  if (isRecord(input.fields) && isRecord(input.fields.project)) candidates.push(input.fields.project.key);
  for (const c of candidates) if (typeof c === "string" && /^[A-Z][A-Z0-9_]+$/.test(c)) return c;
  return null;
}

function findKeyField(value: unknown, depth: number): string | null {
  if (depth > MAX_JSON_DEPTH || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKeyField(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const field of KEY_FIELDS) {
    const v = record[field];
    if (typeof v === "string" && FULL_KEY_RE.test(v)) return v;
  }
  for (const nested of Object.values(record)) {
    const found = findKeyField(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
