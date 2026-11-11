// HTTP client for the runner side of the Task Bus (design §7.5). Owns the runner token and re-registers on 401.
import {
  RUNNER_PATHS,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type NextTaskResponse,
  type RegisterRunnerRequest,
  type RegisterRunnerResponse,
  type TaskEventsRequest,
  type TaskExitedRequest,
  type TaskStartedRequest,
} from "@claude-bridge/protocol";
import { z } from "zod";
import { AbortedError } from "./retry.js";
import type { Logger } from "./logger.js";

/** Extra time on top of `wait` before a long-poll request is considered hung. */
const LONG_POLL_SLACK_MS = 15_000;

export class BusHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "BusHttpError";
  }
}

/** Connection refused, DNS, timeout: the bus may come back, always retryable. */
export class BusNetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BusNetworkError";
  }
}

/** Re-registration inside an authenticated call failed; retryable because the bus may recover. */
export class RegistrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistrationError";
  }
}

export function isRetryableBusError(err: unknown): boolean {
  if (err instanceof BusNetworkError || err instanceof RegistrationError) {
    return true;
  }
  if (err instanceof BusHttpError) {
    return err.status >= 500 || err.status === 429;
  }
  return false;
}

// Minimal shape checks on the fields the runner relies on; extra fields pass through.
const registerResponseSchema = z.looseObject({
  runner_token: z.string().min(1),
  reconcile: z.enum(["continue", "abort", "none"]),
  heartbeat_seconds: z.number().positive(),
});
const nextResponseSchema = z.looseObject({
  task: z.looseObject({ task_id: z.string().min(1), ticket_key: z.string() }),
  task_token: z.string().min(1),
  mcp_url: z.url(),
  prompt: z.string().min(1),
  timeout_seconds: z.number().positive(),
});
const heartbeatResponseSchema = z.looseObject({
  cancel: z.boolean(),
  task_id: z.string().nullish(),
});
const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export interface BusClientOptions {
  busUrl: string;
  registration: Omit<RegisterRunnerRequest, "current_task_id">;
  getBootstrapToken: () => Promise<string>;
  getCurrentTaskId: () => string | null;
  onRegistered: (response: RegisterRunnerResponse) => void;
  requestTimeoutMs: number;
  logger: Logger;
}

interface RawResponse {
  status: number;
  body: unknown;
}

export class BusClient {
  private runnerToken: string | null = null;
  private registering: Promise<RegisterRunnerResponse> | null = null;

  constructor(private readonly options: BusClientOptions) {}

  /** POST /runners/register with the bootstrap token. Concurrent callers share one in-flight request. */
  register(signal: AbortSignal): Promise<RegisterRunnerResponse> {
    if (!this.registering) {
      this.registering = this.doRegister(signal).finally(() => {
        this.registering = null;
      });
    }
    return this.registering;
  }

  /** GET /runners/{id}/next. Returns null on 204. */
  async next(waitSeconds: number, signal: AbortSignal): Promise<NextTaskResponse | null> {
    const res = await this.authed(
      "GET",
      `${RUNNER_PATHS.next(this.options.registration.worker_id)}?wait=${waitSeconds}`,
      undefined,
      signal,
      waitSeconds * 1000 + LONG_POLL_SLACK_MS,
    );
    if (res.status === 204) {
      return null;
    }
    return parseOrThrow(nextResponseSchema, res.body, "next") as unknown as NextTaskResponse;
  }

  async heartbeat(body: HeartbeatRequest, signal: AbortSignal): Promise<HeartbeatResponse> {
    const res = await this.authed("POST", RUNNER_PATHS.heartbeat(this.options.registration.worker_id), body, signal);
    return parseOrThrow(heartbeatResponseSchema, res.body, "heartbeat") as HeartbeatResponse;
  }

  async started(taskId: string, body: TaskStartedRequest, signal: AbortSignal): Promise<void> {
    await this.authed("POST", RUNNER_PATHS.started(taskId), body, signal);
  }

  async events(taskId: string, body: TaskEventsRequest, signal: AbortSignal): Promise<void> {
    await this.authed("POST", RUNNER_PATHS.events(taskId), body, signal);
  }

  async exited(taskId: string, body: TaskExitedRequest, signal: AbortSignal): Promise<void> {
    await this.authed("POST", RUNNER_PATHS.exited(taskId), body, signal);
  }

  private async doRegister(signal: AbortSignal): Promise<RegisterRunnerResponse> {
    const bootstrapToken = await this.options.getBootstrapToken();
    const request: RegisterRunnerRequest = {
      ...this.options.registration,
      current_task_id: this.options.getCurrentTaskId(),
    };
    const res = await this.send("POST", RUNNER_PATHS.register, bootstrapToken, request, signal, this.options.requestTimeoutMs);
    const parsed = parseOrThrow(registerResponseSchema, res.body, "register") as unknown as RegisterRunnerResponse;
    this.runnerToken = parsed.runner_token;
    this.options.logger.info("registered with bus", {
      reconcile: parsed.reconcile,
      current_task_id: request.current_task_id ?? null,
      bus_heartbeat_seconds: parsed.heartbeat_seconds,
    });
    this.options.onRegistered(parsed);
    return parsed;
  }

  /**
   * Sends with the runner token. On 401 (token expired, bus restarted) or 404 WORKER_NOT_FOUND
   * re-registers once and retries; a second rejection is returned to the caller as BusHttpError.
   */
  private async authed(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal: AbortSignal,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<RawResponse> {
    let renewed = false;
    for (;;) {
      if (!this.runnerToken) {
        try {
          await this.register(signal);
        } catch (err) {
          if (err instanceof AbortedError) {
            throw err;
          }
          throw new RegistrationError(`re-register failed: ${(err as Error).message}`, { cause: err });
        }
      }
      const usedToken = this.runnerToken as string;
      try {
        return await this.send(method, path, usedToken, body, signal, timeoutMs);
      } catch (err) {
        const needsRenewal =
          err instanceof BusHttpError && (err.status === 401 || (err.status === 404 && err.code === "WORKER_NOT_FOUND"));
        if (!needsRenewal || renewed) {
          throw err;
        }
        renewed = true;
        this.options.logger.warn("bus rejected runner token, re-registering", { status: err.status, path });
        // Another caller may already have renewed the token; only force a register if it is still the stale one.
        if (this.runnerToken === usedToken) {
          this.runnerToken = null;
        }
      }
    }
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    token: string,
    body: unknown,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<RawResponse> {
    if (signal.aborted) {
      throw new AbortedError();
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    let response: Response;
    try {
      response = await fetch(`${this.options.busUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (err) {
      if (signal.aborted) {
        throw new AbortedError();
      }
      const reason = (err as Error).name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : (err as Error).message;
      throw new BusNetworkError(`${method} ${path}: ${reason}`, { cause: err });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      if (signal.aborted) {
        throw new AbortedError();
      }
      throw new BusNetworkError(`${method} ${path}: reading response failed: ${(err as Error).message}`, { cause: err });
    }

    if (response.status === 204) {
      return { status: 204, body: null };
    }
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      const errorBody = errorBodySchema.safeParse(parsed);
      const code = errorBody.success ? errorBody.data.error.code : null;
      const detail = errorBody.success ? errorBody.data.error.message : text.slice(0, 200);
      throw new BusHttpError(response.status, code, `${method} ${path} -> ${response.status}${code ? ` ${code}` : ""}: ${detail}`);
    }
    return { status: response.status, body: parsed };
  }
}

function parseOrThrow<T extends z.ZodType>(schema: T, body: unknown, what: string): z.output<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    // Malformed 2xx body: treat like a server fault so callers retry instead of crashing the loop.
    throw new BusHttpError(502, null, `malformed ${what} response from bus: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
