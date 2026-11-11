// Định nghĩa tool MCP của bus (mục 7.4): schema zod (cũng là JSON Schema quảng bá cho Claude) + handler.
import {
  type BusErrorBody,
  type OrchestratorToolName,
  type WorkerToolName,
  ORCHESTRATOR_TOOLS,
  TASK_PHASES,
  WORKER_FAIL_CATEGORIES,
  WORKER_TOOLS,
} from "@claude-bridge/protocol";
import { z } from "zod";
import { BusError } from "./errors.js";
import type { TaskBus } from "./taskBus.js";

export type McpPrincipal = { role: "orchestrator" } | { role: "worker"; task_id: string };

type ToolName = OrchestratorToolName | WorkerToolName;

interface BusTool {
  name: ToolName;
  description: string;
  schema: z.ZodObject;
  run(input: unknown, principal: McpPrincipal): unknown;
}

const text = (max: number) => z.string().trim().min(1).max(max);

function tool<S extends z.ZodObject>(
  name: ToolName,
  description: string,
  schema: S,
  run: (input: z.output<S>, principal: McpPrincipal) => unknown,
): BusTool {
  return { name, description, schema, run: (input, principal) => run(input as z.output<S>, principal) };
}

function workerTaskId(principal: McpPrincipal): string {
  // Không xảy ra: dispatcher đã chặn theo role trước khi gọi.
  if (principal.role !== "worker") throw new BusError("FORBIDDEN", "worker tool requires a task token");
  return principal.task_id;
}

export function buildBusTools(bus: TaskBus): Map<ToolName, BusTool> {
  const tools: BusTool[] = [
    tool(
      "list_workers",
      "List worker slots (repo/worktree) with state offline|idle|busy and current task.",
      z.object({ state: z.enum(["offline", "idle", "busy"]).optional(), repo: z.string().min(1).optional() }),
      (input) => bus.listWorkers(input),
    ),
    tool(
      "list_tasks",
      "List tasks, optionally filtered by state or Jira ticket key.",
      z.object({
        state: z.enum(["assigned", "running", "completed", "failed", "cancelled"]).optional(),
        ticket_key: z.string().min(1).optional(),
      }),
      (input) => bus.listTasks(input),
    ),
    tool(
      "assign_task",
      "Assign a Jira ticket to an idle worker. Fails with WORKER_NOT_IDLE, TICKET_ALREADY_ACTIVE, CONCURRENCY_LIMIT or DISPATCH_PAUSED.",
      z.object({ worker_id: text(128), ticket_key: text(64), notes: z.string().max(8000).optional() }),
      (input) => bus.assignTask(input),
    ),
    tool(
      "cancel_task",
      "Cancel an active task; the runner kills the worker process.",
      z.object({ task_id: text(64), reason: text(2000) }),
      (input) => bus.cancelTask(input),
    ),
    tool(
      "report_progress",
      "Report the current phase of your task. Call whenever the phase changes.",
      z.object({ phase: z.enum(TASK_PHASES), message: z.string().max(2000) }),
      (input, p) => {
        bus.reportProgress(workerTaskId(p), input);
        return { ok: true };
      },
    ),
    tool(
      "complete_task",
      "Finish your task successfully with the merge request URL, branch and a short summary.",
      z.object({ mr_url: z.url().max(2000), branch: text(256), summary: text(8000) }),
      (input, p) => {
        bus.completeTask(workerTaskId(p), input);
        return { ok: true };
      },
    ),
    tool(
      "fail_task",
      "Finish your task as failed with a category and reason.",
      z.object({ category: z.enum(WORKER_FAIL_CATEGORIES), reason: text(8000) }),
      (input, p) => {
        bus.failTask(workerTaskId(p), input);
        return { ok: true };
      },
    ),
  ];
  return new Map(tools.map((t) => [t.name, t]));
}

export function toolsForRole(principal: McpPrincipal): readonly ToolName[] {
  return principal.role === "orchestrator" ? ORCHESTRATOR_TOOLS : WORKER_TOOLS;
}

/** JSON Schema cho `tools/list` (bỏ `$schema` để tương thích client MCP cũ). */
export function inputJsonSchema(schema: z.ZodObject): { type: "object"; [k: string]: unknown } {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return { ...json, type: "object" };
}

export interface ToolCallResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [k: string]: unknown;
}

export function okResult(value: unknown): ToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function errorResult(code: BusErrorBody["error"]["code"], message: string): ToolCallResult {
  const body: BusErrorBody = { error: { code, message } };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

/** Kiểm role, validate input, chạy handler; mọi lỗi nghiệp vụ thành tool result `isError`. */
export function callBusTool(
  tools: Map<ToolName, BusTool>,
  principal: McpPrincipal,
  name: string,
  args: unknown,
): ToolCallResult {
  const t = tools.get(name as ToolName);
  if (!t) return errorResult("INVALID_INPUT", `unknown tool ${name}`);
  if (!toolsForRole(principal).includes(t.name)) {
    return errorResult("FORBIDDEN", `tool ${name} is not available to role ${principal.role}`);
  }
  const parsed = t.schema.safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");
    return errorResult("INVALID_INPUT", detail);
  }
  try {
    return okResult(t.run(parsed.data, principal));
  } catch (err) {
    if (err instanceof BusError) return errorResult(err.code, err.message);
    throw err;
  }
}
