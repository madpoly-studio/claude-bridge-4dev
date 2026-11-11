// In-process fake of the Task Bus runner API (design §7.5) plus a minimal MCP endpoint, recording every call.
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type {
  HeartbeatResponse,
  NextTaskResponse,
  RegisterRunnerRequest,
  RegisterRunnerResponse,
  Task,
  TaskExitedRequest,
  TaskStartedRequest,
} from "@claude-bridge/protocol";

export interface RecordedCall {
  method: string;
  path: string;
  token: string | null;
  body: unknown;
  status: number;
}

export interface McpToolCall {
  token: string | null;
  name: string;
  arguments: Record<string, unknown>;
}

const POLL_STEP_MS = 10;

export class FakeBus {
  readonly bootstrapToken = `boot-${randomUUID()}`;
  readonly calls: RecordedCall[] = [];
  readonly mcpToolCalls: McpToolCall[] = [];
  readonly started = new Map<string, TaskStartedRequest>();
  readonly exited = new Map<string, TaskExitedRequest>();
  readonly eventBatches = new Map<string, unknown[][]>();
  /** How long GET next holds before answering 204. */
  nextHoldMs = 100;
  /** Answer this many POST events with 503 before accepting. */
  failEventsTimes = 0;

  private server: http.Server | null = null;
  private baseUrl = "";
  private readonly validRunnerTokens = new Set<string>();
  private readonly taskTokens = new Map<string, string>();
  private readonly queues = new Map<string, NextTaskResponse[]>();
  private readonly cancelRequested = new Set<string>();

  get url(): string {
    return this.baseUrl;
  }

  get mcpUrl(): string {
    return `${this.baseUrl}/mcp`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Queues a task for `workerId`; returns the assignment the runner will receive. */
  enqueue(workerId: string, overrides: { timeout_seconds?: number; prompt?: string } = {}): NextTaskResponse {
    const taskId = `t-${randomUUID().slice(0, 8)}`;
    const task: Task = {
      task_id: taskId,
      ticket_key: "SH-1",
      worker_id: workerId,
      state: "assigned",
      attempt: 1,
      session_id: null,
      phase: null,
      branch: null,
      mr_url: null,
      summary: null,
      fail_category: null,
      fail_reason: null,
      notes: null,
      usage: null,
      assigned_at: new Date().toISOString(),
      started_at: null,
      ended_at: null,
    };
    const assignment: NextTaskResponse = {
      task,
      task_token: `task-${randomUUID()}`,
      mcp_url: this.mcpUrl,
      prompt: overrides.prompt ?? `Thực hiện ticket SH-1 theo flow worker.\ntask_id: ${taskId}`,
      timeout_seconds: overrides.timeout_seconds ?? 60,
    };
    this.taskTokens.set(assignment.task_token, taskId);
    const queue = this.queues.get(workerId) ?? [];
    queue.push(assignment);
    this.queues.set(workerId, queue);
    return assignment;
  }

  /** Next heartbeat answers {cancel: true, task_id}. */
  requestCancel(taskId: string): void {
    this.cancelRequested.add(taskId);
  }

  /** Invalidates every runner token: the next runner call gets 401. */
  revokeRunnerTokens(): void {
    this.validRunnerTokens.clear();
  }

  eventsOf(taskId: string): unknown[] {
    return (this.eventBatches.get(taskId) ?? []).flat();
  }

  callsTo(method: string, pathPrefix: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    const text = await readBody(req);
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const call: RecordedCall = { method: req.method ?? "", path: url.pathname, token, body, status: 0 };
    this.calls.push(call);
    const reply = (status: number, payload?: unknown): void => {
      call.status = status;
      if (payload === undefined) {
        res.writeHead(status).end();
      } else {
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
      }
    };
    const unauthorized = (): void => reply(401, { error: { code: "UNAUTHORIZED", message: "bad token" } });

    if (url.pathname === "/mcp") {
      if (req.method !== "POST" || body === null || typeof body !== "object") {
        // Stateless streamable HTTP: no standalone SSE stream (real claude probes it with GET).
        reply(405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } });
        return;
      }
      this.handleMcp(token, body, reply);
      return;
    }
    if (req.method === "POST" && url.pathname === "/runners/register") {
      if (token !== this.bootstrapToken) {
        unauthorized();
        return;
      }
      const request = body as RegisterRunnerRequest;
      const runnerToken = `runner-${randomUUID()}`;
      this.validRunnerTokens.add(runnerToken);
      const response: RegisterRunnerResponse = {
        runner_token: runnerToken,
        worker: { ...request, state: "idle", current_task_id: request.current_task_id ?? null, last_heartbeat: null },
        reconcile: request.current_task_id ? "continue" : "none",
        heartbeat_seconds: 15,
      };
      reply(200, response);
      return;
    }
    if (!token || !this.validRunnerTokens.has(token)) {
      unauthorized();
      return;
    }

    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [kind, id, action] = segments;
    if (kind === "runners" && id && action === "next" && req.method === "GET") {
      const deadline = Date.now() + this.nextHoldMs;
      for (;;) {
        const assignment = this.queues.get(id)?.shift();
        if (assignment) {
          reply(200, assignment);
          return;
        }
        if (Date.now() >= deadline || req.destroyed) {
          reply(204);
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_STEP_MS));
      }
    }
    if (kind === "runners" && id && action === "heartbeat" && req.method === "POST") {
      const current = (body as { current_task_id: string | null }).current_task_id;
      const response: HeartbeatResponse = { cancel: false };
      if (current && this.cancelRequested.has(current)) {
        response.cancel = true;
        response.task_id = current;
      }
      reply(200, response);
      return;
    }
    if (kind === "tasks" && id && req.method === "POST") {
      if (action === "started") {
        this.started.set(id, body as TaskStartedRequest);
      } else if (action === "events") {
        if (this.failEventsTimes > 0) {
          this.failEventsTimes -= 1;
          reply(503, { error: { code: "UNAVAILABLE", message: "temporarily unavailable" } });
          return;
        }
        const batches = this.eventBatches.get(id) ?? [];
        batches.push((body as { events: unknown[] }).events);
        this.eventBatches.set(id, batches);
      } else if (action === "exited") {
        this.exited.set(id, body as TaskExitedRequest);
      } else {
        reply(404, { error: { code: "TASK_NOT_FOUND", message: "unknown action" } });
        return;
      }
      reply(200, { ok: true });
      return;
    }
    reply(404, { error: { code: "TASK_NOT_FOUND", message: `no route ${req.method} ${url.pathname}` } });
  }

  private handleMcp(token: string | null, body: unknown, reply: (status: number, payload?: unknown) => void): void {
    if (!token || !this.taskTokens.has(token)) {
      reply(401, { error: { code: "UNAUTHORIZED", message: "bad task token" } });
      return;
    }
    const msg = body as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (msg.method === "initialize") {
      reply(200, {
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-bus", version: "0" } },
      });
      return;
    }
    if (msg.id === undefined) {
      reply(202);
      return;
    }
    if (msg.method === "tools/call") {
      this.mcpToolCalls.push({ token, name: msg.params?.name ?? "", arguments: msg.params?.arguments ?? {} });
      reply(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
      return;
    }
    reply(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Polls `probe` until it returns a non-undefined value. */
export async function waitFor<T>(probe: () => T | undefined, timeoutMs = 15_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
