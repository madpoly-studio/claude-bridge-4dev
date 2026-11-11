// Ánh xạ input của tool tạo issue Jira (bản nháp ticket) sang trường hiển thị, và ghi ngược khi Sửa.
// Input khác nhau tùy MCP server Jira, nên đọc phòng thủ nhiều tên khóa.

type Obj = Record<string, unknown>;

export interface TicketDraft {
  type: string | null;
  project: string | null;
  labels: string[];
  title: string | null;
  description: string | null;
  solution: string | null;
  acceptance: string[];
}

export interface DraftEdits {
  summary: string;
  description: string;
  labels: string[];
}

const TITLE_KEYS = ["summary", "title"] as const;
const DESCRIPTION_KEYS = ["description", "body"] as const;
const TYPE_KEYS = ["issue_type", "issuetype", "issueType", "type"] as const;
const PROJECT_KEYS = ["project_key", "projectKey", "project"] as const;
const SOLUTION_KEYS = ["solution"] as const;
const ACCEPTANCE_KEYS = ["acceptance_criteria", "acceptanceCriteria"] as const;
const ACCEPTANCE_HEADING_RE = /^\s*(?:#+\s*|\*+\s*)?(tiêu chí nghiệm thu|acceptance criteria)\s*\**\s*:?\s*\**\s*$/i;
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)]|\[[ xX]\])\s+/;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseMaybeJson(v: unknown): Obj | null {
  if (isObj(v)) return v;
  if (typeof v !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Lấy text từ chuỗi hoặc Atlassian Document Format. */
function textOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (isObj(v)) {
    if (typeof v.name === "string") return v.name;
    if (typeof v.key === "string") return v.key;
    if (typeof v.value === "string") return v.value;
    if (Array.isArray(v.content)) return adfText(v);
  }
  return null;
}

function adfText(node: unknown): string {
  if (!isObj(node)) return "";
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content)) return "";
  const inline = node.type === "paragraph" || node.type === "heading";
  return node.content
    .map(adfText)
    .filter(Boolean)
    .join(inline ? "" : "\n");
}

function listOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => textOf(x)).filter((x): x is string => !!x && x.trim() !== "");
  if (typeof v === "string") {
    return v
      .split(/[\n,]/)
      .map((s) => s.replace(BULLET_RE, "").trim())
      .filter(Boolean);
  }
  return [];
}

/** Các tầng có thể chứa trường: input gốc, `fields`, `issue`, `additional_fields` (chuỗi JSON hoặc object). */
function layers(input: Obj): Obj[] {
  const out: Obj[] = [input];
  for (const k of ["fields", "issue"]) {
    const v = input[k];
    if (isObj(v)) out.push(v);
  }
  const extra = parseMaybeJson(input.additional_fields);
  if (extra) out.push(extra);
  return out;
}

function pick(ls: Obj[], keys: readonly string[]): unknown {
  for (const layer of ls) {
    for (const k of keys) {
      const v = layer[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
  }
  return undefined;
}

/** Tách phần "Tiêu chí nghiệm thu" ra khỏi mô tả nếu có heading tương ứng. */
export function splitAcceptance(description: string): { body: string; acceptance: string[] } {
  const lines = description.split(/\r?\n/);
  const idx = lines.findIndex((l) => ACCEPTANCE_HEADING_RE.test(l));
  if (idx < 0) return { body: description, acceptance: [] };
  const acceptance: string[] = [];
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*#+\s+/.test(line)) {
      end = i;
      break;
    }
    const item = line.replace(BULLET_RE, "").trim();
    if (item) acceptance.push(item);
  }
  const body = [...lines.slice(0, idx), ...lines.slice(end)].join("\n").trim();
  return { body, acceptance };
}

export function draftFromInput(input: Record<string, unknown> | null | undefined): TicketDraft {
  const src = isObj(input) ? input : {};
  const ls = layers(src);
  const rawDescription = textOf(pick(ls, DESCRIPTION_KEYS));
  let acceptance = listOf(pick(ls, ACCEPTANCE_KEYS));
  let description = rawDescription;
  if (rawDescription && acceptance.length === 0) {
    const split = splitAcceptance(rawDescription);
    if (split.acceptance.length > 0) {
      acceptance = split.acceptance;
      description = split.body || null;
    }
  }
  return {
    type: textOf(pick(ls, TYPE_KEYS)),
    project: textOf(pick(ls, PROJECT_KEYS)),
    labels: listOf(pick(ls, ["labels"])),
    title: textOf(pick(ls, TITLE_KEYS)),
    description,
    solution: textOf(pick(ls, SOLUTION_KEYS)),
    acceptance,
  };
}

/** Giá trị ban đầu cho form Sửa (mô tả giữ nguyên văn để không mất phần nghiệm thu). */
export function editsFromInput(input: Record<string, unknown> | null | undefined): DraftEdits {
  const src = isObj(input) ? input : {};
  const ls = layers(src);
  const description = pick(ls, DESCRIPTION_KEYS);
  return {
    summary: textOf(pick(ls, TITLE_KEYS)) ?? "",
    description: typeof description === "string" ? description : (textOf(description) ?? ""),
    labels: listOf(pick(ls, ["labels"])),
  };
}

/** Tìm tầng đang chứa một trong các khóa; trả tên khóa và nơi chứa. */
function locate(input: Obj, keys: readonly string[]): { holder: "root" | "fields" | "issue" | "additional"; key: string } | null {
  const tryObj = (o: unknown) => (isObj(o) ? keys.find((k) => o[k] !== undefined) : undefined);
  const rootKey = tryObj(input);
  if (rootKey) return { holder: "root", key: rootKey };
  for (const h of ["fields", "issue"] as const) {
    const k = tryObj(input[h]);
    if (k) return { holder: h, key: k };
  }
  const k = tryObj(parseMaybeJson(input.additional_fields));
  return k ? { holder: "additional", key: k } : null;
}

/** Ghi các chỉnh sửa vào bản sao input, giữ đúng vị trí và định dạng khóa gốc. */
export function applyDraftEdits(input: Record<string, unknown>, edits: DraftEdits): Record<string, unknown> {
  const out: Obj = structuredCloneSafe(input);
  const additionalWasString = typeof out.additional_fields === "string";
  let additional = parseMaybeJson(out.additional_fields);

  const write = (keys: readonly string[], value: unknown, fallbackKey: string) => {
    const loc = locate(out, keys);
    if (!loc) {
      // Input dạng Jira REST: trường mới thuộc về `fields`.
      if (isObj(out.fields)) out.fields = { ...out.fields, [fallbackKey]: value };
      else out[fallbackKey] = value;
      return;
    }
    if (loc.holder === "root") out[loc.key] = value;
    else if (loc.holder === "additional") {
      additional = { ...(additional ?? {}), [loc.key]: value };
    } else {
      out[loc.holder] = { ...(out[loc.holder] as Obj), [loc.key]: value };
    }
  };

  write(TITLE_KEYS, edits.summary, "summary");
  write(DESCRIPTION_KEYS, edits.description, "description");
  const labelsLoc = locate(out, ["labels"]);
  const existingLabels = labelsLoc ? pick(layers(out), ["labels"]) : undefined;
  write(["labels"], typeof existingLabels === "string" ? edits.labels.join(",") : edits.labels, "labels");

  if (additional) out.additional_fields = additionalWasString ? JSON.stringify(additional) : additional;
  return out;
}

function structuredCloneSafe(input: Obj): Obj {
  try {
    return JSON.parse(JSON.stringify(input)) as Obj;
  } catch {
    return { ...input };
  }
}

export function parseLabels(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
