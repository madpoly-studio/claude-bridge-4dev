// HTTP API cho Worker Runner (mục 7.5). Đường dẫn suy ra từ RUNNER_PATHS của protocol.
import {
  type HeartbeatResponse,
  type NextTaskResponse,
  type OkResponse,
  type RegisterRunnerResponse,
  DEFAULTS,
  RUNNER_PATHS,
} from "@claude-bridge/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BusError, httpStatusOf } from "./errors.js";
import type { RunnerService } from "./runnerService.js";
import { type BusTokens, bearerToken } from "./tokens.js";

/** Long-poll tối đa; runner gửi `wait=30` (DEFAULTS.LONG_POLL_WAIT_SECONDS). */
export const MAX_LONG_POLL_SECONDS = 60;
const MAX_EVENTS_PER_BATCH = 5000;

/** Biến hàm RUNNER_PATHS thành mẫu route Fastify, ví dụ `/runners/:workerId/next`. */
function routePattern(build: (id: string) => string, param: string): string {
  const placeholder = "__param__";
  return build(placeholder).replace(placeholder, `:${param}`);
}

const idSchema = z.string().trim().min(1).max(128);
const nullableText = z.string().max(8000).nullable().optional();

const registerSchema = z.object({
  worker_id: idSchema,
  repo: z.string().min(1).max(256),
  worktree_path: z.string().min(1).max(1024),
  host: z.string().min(1).max(256),
  current_task_id: idSchema.nullable().optional(),
});
const heartbeatSchema = z.object({ current_task_id: idSchema.nullable().default(null) });
const startedSchema = z.object({
  session_id: z.string().min(1).max(256).nullable(),
  pid: z.number().int().nonnegative().nullable(),
});
const eventsSchema = z.object({ events: z.array(z.unknown()).max(MAX_EVENTS_PER_BATCH) });
const exitedSchema = z.object({
  exit_code: z.number().int().nullable(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      total_cost_usd: z.number().optional(),
    })
    .catchall(z.unknown())
    .nullable(),
  reason: z.enum(["timeout", "cancelled", "conflict", "spawn_error"]).nullable().optional(),
  message: nullableText,
});
const nextQuerySchema = z.object({
  wait: z.coerce.number().min(0).max(MAX_LONG_POLL_SECONDS).default(DEFAULTS.LONG_POLL_WAIT_SECONDS),
});

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
    throw new BusError("INVALID_INPUT", detail);
  }
  return result.data;
}

type Params = { workerId?: string; taskId?: string };

export function registerRunnerRoutes(app: FastifyInstance, deps: { runners: RunnerService; tokens: BusTokens }): void {
  const { runners, tokens } = deps;
  const token = (req: FastifyRequest): string | null => bearerToken(req.headers.authorization);
  const param = (req: FastifyRequest, name: keyof Params): string => parse(idSchema, (req.params as Params)[name]);

  app.post(RUNNER_PATHS.register, async (req): Promise<RegisterRunnerResponse> => {
    const t = token(req);
    if (!t || !tokens.isRunnerBootstrapToken(t)) throw new BusError("UNAUTHORIZED", "invalid runner bootstrap token");
    return runners.register(parse(registerSchema, req.body));
  });

  app.get(routePattern(RUNNER_PATHS.next, "workerId"), async (req, reply: FastifyReply): Promise<NextTaskResponse | undefined> => {
    const workerId = param(req, "workerId");
    runners.authorizeWorker(token(req), workerId);
    const { wait } = parse(nextQuerySchema, req.query);
    // Runner ngắt kết nối giữa chừng → thả waiter ngay.
    const abort = new AbortController();
    const onClose = (): void => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.on("close", onClose);
    try {
      const next = await runners.next(workerId, wait, abort.signal);
      if (!next) {
        reply.code(204);
        return undefined;
      }
      return next;
    } finally {
      reply.raw.off("close", onClose);
    }
  });

  app.post(routePattern(RUNNER_PATHS.heartbeat, "workerId"), async (req): Promise<HeartbeatResponse> => {
    const workerId = param(req, "workerId");
    runners.authorizeWorker(token(req), workerId);
    return runners.heartbeat(workerId, parse(heartbeatSchema, req.body));
  });

  app.post(routePattern(RUNNER_PATHS.started, "taskId"), async (req): Promise<OkResponse> => {
    const task = runners.authorizeTask(token(req), param(req, "taskId"));
    runners.started(task, parse(startedSchema, req.body));
    return { ok: true };
  });

  app.post(routePattern(RUNNER_PATHS.events, "taskId"), async (req): Promise<OkResponse> => {
    const task = runners.authorizeTask(token(req), param(req, "taskId"));
    runners.events(task, parse(eventsSchema, req.body));
    return { ok: true };
  });

  app.post(routePattern(RUNNER_PATHS.exited, "taskId"), async (req): Promise<OkResponse> => {
    const task = runners.authorizeTask(token(req), param(req, "taskId"));
    runners.exited(task, parse(exitedSchema, req.body));
    return { ok: true };
  });
}

/** Error handler dùng chung cho route bus: BusError → BusErrorBody với HTTP status tương ứng. */
export function busErrorHandler(
  err: Error & { statusCode?: number; validation?: unknown },
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof BusError) {
    void reply.code(httpStatusOf(err.code)).send(err.toBody());
    return;
  }
  // Lỗi parse JSON / body quá lớn của Fastify.
  if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
    void reply.code(err.statusCode).send(new BusError("INVALID_INPUT", err.message).toBody());
    return;
  }
  req.log.error({ err }, "unhandled error");
  void reply.code(500).send({ error: { code: "INTERNAL", message: "internal error" } });
}
