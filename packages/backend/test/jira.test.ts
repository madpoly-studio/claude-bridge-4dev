// Jira Reader (mục 5.4, I3): đọc .env của team, JQL, phân trang, ánh xạ Ticket + blocked_by, status ok/error/unconfigured.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraReader } from "../src/jira/jiraReader.js";
import { mapIssue, ticketQueueJql } from "../src/jira/jiraMapping.js";
import { loadJiraSettings, parseDotenv } from "../src/jira/jiraSettings.js";
import { type Logger } from "../src/util/logger.js";
import { type AgentHarness, startAgentHarness } from "./agentHarness.js";
import { FakeClock, FakeTimers, removeDir, tempDir } from "./helpers.js";

const PAT = "super-secret-pat-value";
const BASE = "https://jira.example.test";

const issue = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  fields: {
    summary: `Summary ${key}`,
    issuetype: { name: "Story" },
    status: { name: "To Do", statusCategory: { key: "new" } },
    labels: ["agent"],
    issuelinks: [],
    updated: "2026-11-11T09:00:00.000+0700",
    ...extra,
  },
});

const blockLink = (key: string, category: string, direction: "inwardIssue" | "outwardIssue" = "inwardIssue", name = "Blocks") => ({
  type: { name, inward: name === "Blocks" ? "is blocked by" : "relates to", outward: name === "Blocks" ? "blocks" : "relates to" },
  [direction]: { key, fields: { status: { name: "x", statusCategory: { key: category } } } },
});

interface FakeJira {
  server: Server;
  url: string;
  requests: { url: URL; auth: string | undefined }[];
  issues: unknown[];
  pageSize: number;
  status: number;
}

async function startFakeJira(): Promise<FakeJira> {
  const state: FakeJira = { server: null as unknown as Server, url: "", requests: [], issues: [], pageSize: 2, status: 200 };
  state.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    state.requests.push({ url, auth: req.headers.authorization });
    if (url.pathname !== "/jira/rest/api/2/search") {
      res.writeHead(404).end();
      return;
    }
    if (state.status !== 200) {
      res.writeHead(state.status, { "content-type": "application/json" }).end('{"errorMessages":["Unauthorized"]}');
      return;
    }
    const startAt = Number(url.searchParams.get("startAt") ?? "0");
    const page = state.issues.slice(startAt, startAt + state.pageSize);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ startAt, maxResults: state.pageSize, total: state.issues.length, issues: page }),
    );
  });
  await new Promise<void>((resolve) => state.server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}/jira`;
  return state;
}

function capturingLogger(lines: string[]): Logger {
  const push = (obj: object, msg?: string): void => {
    lines.push(`${msg ?? ""} ${JSON.stringify(obj)}`);
  };
  return { debug: push, info: push, warn: push, error: push };
}

describe("Jira mapping", () => {
  it("builds the queue JQL", () => {
    expect(ticketQueueJql("SH", "agent")).toBe('project = "SH" AND labels = "agent" AND statusCategory != Done ORDER BY updated DESC');
  });

  it("maps fields, url and blocked_by (inward blocking links that are not done)", () => {
    const t = mapIssue(
      issue("SH-1", {
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
        issuelinks: [
          blockLink("SH-2", "new"),
          blockLink("SH-3", "done"),
          blockLink("SH-4", "indeterminate", "outwardIssue"),
          blockLink("SH-5", "new", "inwardIssue", "Relates"),
          blockLink("SH-6", "indeterminate"),
        ],
      }) as never,
      BASE,
    );
    expect(t).toEqual({
      key: "SH-1",
      summary: "Summary SH-1",
      issue_type: "Story",
      status: "In Progress",
      status_category: "indeterminate",
      labels: ["agent"],
      url: `${BASE}/browse/SH-1`,
      blocked_by: ["SH-2", "SH-6"],
      updated: "2026-11-11T09:00:00.000+0700",
    });
  });
});

describe("Jira settings", () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => removeDir(dir));

  it("parses dotenv: export, quotes, comments", () => {
    expect(
      parseDotenv(
        [
          "# comment",
          "export A=1",
          'B="two words # not a comment"',
          "C='single \\n raw'",
          "D=value # trailing comment",
          "E=https://x/y#frag",
          'F="line\\nbreak"',
          "  ",
          "BAD LINE",
        ].join("\r\n"),
      ),
    ).toEqual({ A: "1", B: "two words # not a comment", C: "single \\n raw", D: "value", E: "https://x/y#frag", F: "line\nbreak" });
  });

  it("reads MPS_* from the env file and resolves the CA bundle against its folder", () => {
    mkdirSync(join(dir, "certs"));
    writeFileSync(join(dir, "certs", "ca.pem"), "PEM-DATA");
    const env = join(dir, ".env");
    writeFileSync(env, `MPS_JIRA_URL=${BASE}/\nMPS_JIRA_PAT=${PAT}\nMPS_JIRA_PROJECT_KEY=SH\nMPS_CA_BUNDLE=certs/ca.pem\n`);
    const res = loadJiraSettings(env);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.settings).toMatchObject({ baseUrl: BASE, token: PAT, projectKey: "SH" });
    expect(res.settings.ca?.toString()).toBe("PEM-DATA");
  });

  it("is unconfigured without file or variables, error on a missing CA bundle", () => {
    expect(loadJiraSettings(null).status).toBe("unconfigured");
    expect(loadJiraSettings(join(dir, "missing.env")).status).toBe("unconfigured");
    const env = join(dir, ".env");
    writeFileSync(env, `MPS_JIRA_URL=${BASE}\n`);
    expect(loadJiraSettings(env).status).toBe("unconfigured");
    writeFileSync(env, `MPS_JIRA_URL=${BASE}\nMPS_JIRA_PAT=${PAT}\nMPS_CA_BUNDLE=nope.pem\n`);
    expect(loadJiraSettings(env)).toMatchObject({ status: "error" });
  });
});

describe("Jira Reader", () => {
  let jira: FakeJira;
  let dir: string;
  beforeEach(async () => {
    jira = await startFakeJira();
    dir = tempDir();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => jira.server.close(() => resolve()));
    removeDir(dir);
  });

  function reader(logLines: string[] = [], projects: string[] = ["SH"]): { r: JiraReader; timers: FakeTimers } {
    const env = join(dir, ".env");
    writeFileSync(env, `MPS_JIRA_URL=${jira.url}\nMPS_JIRA_PAT=${PAT}\nMPS_JIRA_PROJECT_KEY=SH\n`);
    const timers = new FakeTimers(new FakeClock());
    const r = new JiraReader({
      settings: loadJiraSettings(env),
      projects,
      agentLabel: "agent",
      pollMs: 60_000,
      timers,
      log: capturingLogger(logLines),
    });
    return { r, timers };
  }

  it("paginates with the bearer PAT, maps tickets and reports ok", async () => {
    jira.issues = [issue("SH-1"), issue("SH-2", { issuelinks: [blockLink("SH-1", "new")] }), issue("SH-3")];
    const { r } = reader();
    const changes: number[] = [];
    r.onTicketsChanged((t) => changes.push(t.length));
    await r.refresh();
    expect(r.status()).toBe("ok");
    expect(r.tickets().map((t) => t.key)).toEqual(["SH-1", "SH-2", "SH-3"]);
    expect(r.tickets()[1]?.blocked_by).toEqual(["SH-1"]);
    expect(r.tickets()[0]?.url).toBe(`${jira.url}/browse/SH-1`);
    expect(jira.requests).toHaveLength(2);
    expect(jira.requests.every((q) => q.auth === `Bearer ${PAT}`)).toBe(true);
    expect(jira.requests[0]?.url.searchParams.get("jql")).toBe(ticketQueueJql("SH", "agent"));
    expect(jira.requests[0]?.url.searchParams.get("fields")).toBe("summary,issuetype,status,labels,issuelinks,updated");
    expect(jira.requests.map((q) => q.url.searchParams.get("startAt"))).toEqual(["0", "2"]);
    // Không đổi thì không phát lại.
    await r.refresh();
    expect(changes).toEqual([3]);
    r.stop();
  });

  it("uses MPS_JIRA_PROJECT_KEY when no project is configured; coalesces concurrent refreshes", async () => {
    jira.issues = [issue("SH-1")];
    const { r } = reader([], []);
    await Promise.all([r.refresh(), r.refresh(), r.refresh()]);
    expect(jira.requests.length).toBe(2); // một lần đang chạy + đúng một lần gộp
    expect(jira.requests[0]?.url.searchParams.get("jql")).toContain('project = "SH"');
    r.stop();
  });

  it("reports error on HTTP failure without logging the token, and polls on the interval", async () => {
    jira.status = 401;
    const lines: string[] = [];
    const { r, timers } = reader(lines);
    const statuses: string[] = [];
    r.onStatusChanged((s) => statuses.push(s));
    r.start();
    await vi.waitFor(() => expect(r.status()).toBe("error"));
    expect(lines.join("\n")).toContain("401");
    expect(lines.join("\n")).not.toContain(PAT);

    jira.status = 200;
    jira.issues = [issue("SH-9")];
    timers.advance(60_000);
    await vi.waitFor(() => expect(r.status()).toBe("ok"));
    expect(statuses).toEqual(["error", "ok"]);
    expect(r.tickets().map((t) => t.key)).toEqual(["SH-9"]);
    r.stop();
  });
});

describe("Jira Reader wired into the backend", () => {
  let h: AgentHarness;
  let jira: FakeJira;
  afterEach(async () => {
    await h?.dispose();
    await new Promise<void>((resolve) => jira.server.close(() => resolve()));
  });

  it("serves tickets in the snapshot, refreshes on ticket.created and on tickets.refresh, sets status.jira", async () => {
    jira = await startFakeJira();
    jira.issues = [issue("SH-1")];
    const dir = tempDir();
    writeFileSync(join(dir, "team.env"), `MPS_JIRA_URL=${jira.url}\nMPS_JIRA_PAT=${PAT}\n`);
    h = await startAgentHarness({ dir, config: { jira_env_file: "team.env" } });
    await vi.waitFor(() => expect(h.bridge.status.get().jira).toBe("ok"));
    const ws = await h.open();
    const snap = await ws.waitFor((m) => m.type === "state.snapshot");
    expect(snap.payload.tickets.map((t: { key: string }) => t.key)).toEqual(["SH-1"]);
    expect(snap.payload.status.jira).toBe("ok");

    jira.issues = [issue("SH-1"), issue("SH-2")];
    const before = jira.requests.length;
    h.bridge.bus.emitTicketCreated({ ticket_key: "SH-2", session_id: "s-1", labels: ["agent"] });
    const updated = await ws.waitFor((m) => m.type === "tickets.updated");
    expect(updated.payload.tickets.map((t: { key: string }) => t.key)).toEqual(["SH-1", "SH-2"]);
    expect(jira.requests.length).toBe(before + 1);

    const ack = await ws.request("tickets.refresh", {});
    expect(ack.payload.result).toEqual({ refreshed: true, jira: "ok", count: 2 });
  });

  it("is unconfigured without jira_env_file", async () => {
    jira = await startFakeJira();
    h = await startAgentHarness();
    expect(h.bridge.status.get().jira).toBe("unconfigured");
    const ws = await h.open();
    const ack = await ws.request("tickets.refresh", {});
    expect(ack.payload.result).toEqual({ refreshed: false, jira: "unconfigured" });
    expect(jira.requests).toHaveLength(0);
  });
});
