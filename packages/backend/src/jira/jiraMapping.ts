// JQL hàng đợi ticket và ánh xạ issue Jira → Ticket của protocol (mục 5.4).
import type { Ticket } from "@claude-bridge/protocol";
import type { JiraIssue } from "./jiraClient.js";

export const TICKET_FIELDS = ["summary", "issuetype", "status", "labels", "issuelinks", "updated"] as const;

/** Tên link type chặn của Jira mặc định; phía inward là "is blocked by". */
const BLOCKS_LINK_TYPE = "blocks";
const BLOCKED_BY_INWARD = "is blocked by";

export function ticketQueueJql(projectKey: string, agentLabel: string): string {
  return `project = "${escapeJql(projectKey)}" AND labels = "${escapeJql(agentLabel)}" AND statusCategory != Done ORDER BY updated DESC`;
}

export function mapIssue(issue: JiraIssue, baseUrl: string): Ticket {
  const f = issue.fields;
  const status = record(f.status);
  return {
    key: issue.key,
    summary: str(f.summary) ?? "",
    issue_type: str(record(f.issuetype)?.name) ?? "",
    status: str(status?.name) ?? "",
    status_category: str(record(status?.statusCategory)?.key) ?? "",
    labels: Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === "string") : [],
    url: `${baseUrl}/browse/${encodeURIComponent(issue.key)}`,
    blocked_by: blockedBy(f.issuelinks),
    updated: str(f.updated) ?? null,
  };
}

/** Link inward loại chặn ("is blocked by" / type "Blocks") mà issue chặn chưa ở statusCategory done. */
function blockedBy(links: unknown): string[] {
  if (!Array.isArray(links)) return [];
  const out: string[] = [];
  for (const raw of links) {
    const link = record(raw);
    const inward = record(link?.inwardIssue);
    if (!link || !inward) continue;
    const type = record(link.type);
    const isBlocking =
      str(type?.name)?.toLowerCase() === BLOCKS_LINK_TYPE || str(type?.inward)?.toLowerCase() === BLOCKED_BY_INWARD;
    if (!isBlocking) continue;
    const category = str(record(record(record(inward.fields)?.status)?.statusCategory)?.key);
    const key = str(inward.key);
    if (key && category !== "done" && !out.includes(key)) out.push(key);
  }
  return out;
}

function escapeJql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
