// MCP thật qua HTTP (port 0) bằng Client + StreamableHTTPClientTransport của SDK.
import { ORCHESTRATOR_TOOLS, WORKER_TOOLS } from "@claude-bridge/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestContext, registerRunners, removeDir, startBridge } from "./helpers.js";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "bus-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value: any }> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { isError: res.isError === true, value: JSON.parse(res.content[0]?.text ?? "null") };
}

describe("bus MCP endpoint (7.4, 7.6)", () => {
  let ctx: TestContext;
  let orchestrator: Client;

  beforeAll(async () => {
    ctx = await startBridge({ listen: true, config: { max_concurrency: 3 } });
    await registerRunners(ctx.bridge, "w-1", "w-2");
    orchestrator = await connect(ctx.bridge.mcpUrl(), ctx.bridge.tokens.getOrchestratorToken("SH"));
  });
  afterAll(async () => {
    await orchestrator.close();
    await ctx.bridge.close();
    removeDir(ctx.dir);
  });

  it("lists only the tools of the token's role", async () => {
    const orchTools = (await orchestrator.listTools()).tools;
    expect(orchTools.map((t) => t.name).sort()).toEqual([...ORCHESTRATOR_TOOLS].sort());
    const assign = orchTools.find((t) => t.name === "assign_task");
    expect(assign?.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["worker_id", "ticket_key"]) });
  });

  it("orchestrator assigns; worker reports progress and completes through its task token", async () => {
    const workers = await call(orchestrator, "list_workers", { state: "idle" });
    expect(workers.value.map((w: { worker_id: string }) => w.worker_id)).toEqual(["w-1", "w-2"]);

    const assigned = await call(orchestrator, "assign_task", { worker_id: "w-1", ticket_key: "SH-21", notes: "small" });
    expect(assigned.isError).toBe(false);
    const taskId: string = assigned.value.task_id;

    const dup = await call(orchestrator, "assign_task", { worker_id: "w-2", ticket_key: "SH-21" });
    expect(dup).toEqual({ isError: true, value: { error: { code: "TICKET_ALREADY_ACTIVE", message: expect.any(String) } } });

    const next = await fetch(`${ctx.bridge.baseUrl()}/runners/w-1/next?wait=0`, {
      headers: { authorization: `Bearer ${(await registerRunnersToken(ctx, "w-1"))}` },
    });
    expect(next.status).toBe(200);
    const delivery = (await next.json()) as { task_token: string; mcp_url: string };
    expect(delivery.mcp_url).toBe(ctx.bridge.mcpUrl());

    const worker = await connect(delivery.mcp_url, delivery.task_token);
    try {
      expect((await worker.listTools()).tools.map((t) => t.name).sort()).toEqual([...WORKER_TOOLS].sort());

      // Task token không gọi được tool orchestrator.
      const forbidden = await call(worker, "assign_task", { worker_id: "w-2", ticket_key: "SH-22" });
      expect(forbidden).toMatchObject({ isError: true, value: { error: { code: "FORBIDDEN" } } });

      const invalid = await call(worker, "report_progress", { phase: "dreaming", message: "x" });
      expect(invalid).toMatchObject({ isError: true, value: { error: { code: "INVALID_INPUT" } } });

      expect(await call(worker, "report_progress", { phase: "implementing", message: "writing code" })).toEqual({
        isError: false,
        value: { ok: true },
      });
      expect(ctx.bridge.bus.getTask(taskId)).toMatchObject({ state: "running", phase: "implementing" });

      expect(await call(worker, "complete_task", { mr_url: "https://git.example/sh/-/merge_requests/9", branch: "feat/SH-21", summary: "done" }))
        .toEqual({ isError: false, value: { ok: true } });
      expect(ctx.bridge.bus.getTask(taskId)).toMatchObject({ state: "completed", branch: "feat/SH-21" });

      const again = await call(worker, "fail_task", { category: "other", reason: "too late" });
      expect(again).toMatchObject({ isError: true, value: { error: { code: "TASK_NOT_ACTIVE" } } });
    } finally {
      await worker.close();
    }

    const tasks = await call(orchestrator, "list_tasks", { ticket_key: "SH-21" });
    expect(tasks.value).toHaveLength(1);
    expect(tasks.value[0]).toMatchObject({ task_id: taskId, state: "completed" });

    const workerTool = await call(orchestrator, "complete_task", { mr_url: "https://x.example/1", branch: "b", summary: "s" });
    expect(workerTool).toMatchObject({ isError: true, value: { error: { code: "FORBIDDEN" } } });
  });

  it("a task token only acts on its own task", async () => {
    const a = (await call(orchestrator, "assign_task", { worker_id: "w-1", ticket_key: "SH-31" })).value.task_id as string;
    const b = (await call(orchestrator, "assign_task", { worker_id: "w-2", ticket_key: "SH-32" })).value.task_id as string;
    const tokenA = ctx.bridge.bus.tokenForDelivery(ctx.bridge.bus.getTask(a)!);
    const worker = await connect(ctx.bridge.mcpUrl(), tokenA);
    try {
      await call(worker, "fail_task", { category: "blocked", reason: "waiting on SH-30" });
    } finally {
      await worker.close();
    }
    expect(ctx.bridge.bus.getTask(a)).toMatchObject({ state: "failed", fail_category: "blocked" });
    expect(ctx.bridge.bus.getTask(b)?.state).toBe("assigned");

    const cancelled = await call(orchestrator, "cancel_task", { task_id: b, reason: "reprioritised" });
    expect(cancelled.value).toMatchObject({ task_id: b, state: "cancelled" });
    const twice = await call(orchestrator, "cancel_task", { task_id: b, reason: "again" });
    expect(twice).toMatchObject({ isError: true, value: { error: { code: "TASK_ALREADY_TERMINAL" } } });
  });

  it("rejects missing / bad tokens with HTTP 401", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const none = await fetch(ctx.bridge.mcpUrl(), { method: "POST", headers, body });
    expect(none.status).toBe(401);
    const bad = await fetch(ctx.bridge.mcpUrl(), { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "invalid bus token" } });
    await expect(connect(ctx.bridge.mcpUrl(), "nope")).rejects.toThrow();
  });

  it("plain JSON-RPC tools/call works without an MCP session", async () => {
    const res = await fetch(ctx.bridge.mcpUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ctx.bridge.tokens.getOrchestratorToken("SH")}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_workers", arguments: {} } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: number; result: ToolResult };
    expect(json.id).toBe(7);
    expect(JSON.parse(json.result.content[0]!.text)).toHaveLength(2);
    expect((await fetch(ctx.bridge.mcpUrl())).status).toBe(405);
  });

  it("Claude CLI probe sequence: server/discover → method-not-found, GET → 405, then raw worker tools/call works", async () => {
    const assigned = await call(orchestrator, "assign_task", { worker_id: "w-1", ticket_key: "SH-41" });
    const taskId = assigned.value.task_id as string;
    const taskToken = ctx.bridge.bus.tokenForDelivery(ctx.bridge.bus.getTask(taskId)!);
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${taskToken}`,
    };
    const rpc = async (id: number, method: string, params: unknown) => {
      const res = await fetch(ctx.bridge.mcpUrl(), { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      return { status: res.status, json: (await res.json()) as { error?: { code: number }; result?: ToolResult } };
    };

    const discover = await rpc(1, "server/discover", {});
    expect(discover.status).toBe(200);
    expect(discover.json.error?.code).toBe(-32601);
    expect((await fetch(ctx.bridge.mcpUrl(), { headers })).status).toBe(405);

    // Không initialize trước (fixture fake-claude của runner làm đúng như vậy).
    const done = await rpc(2, "tools/call", {
      name: "complete_task",
      arguments: { mr_url: "https://git.example/sh/-/merge_requests/41", branch: "feat/SH-41", summary: "ok" },
    });
    expect(done.status).toBe(200);
    expect(done.json.result?.isError).toBeUndefined();
    expect(ctx.bridge.bus.getTask(taskId)?.state).toBe("completed");
  });
});

/** Đăng ký lại để lấy runner token qua HTTP thật (runner token cũ bị thay, không sao trong test này). */
async function registerRunnersToken(ctx: TestContext, workerId: string): Promise<string> {
  const res = await fetch(`${ctx.bridge.baseUrl()}/runners/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.bridge.runnerBootstrapToken}` },
    body: JSON.stringify({ worker_id: workerId, repo: "sh", worktree_path: `D:/wt/${workerId}`, host: "localhost" }),
  });
  const json = (await res.json()) as { runner_token: string; reconcile: string };
  expect(json.reconcile).toBe("none");
  return json.runner_token;
}
