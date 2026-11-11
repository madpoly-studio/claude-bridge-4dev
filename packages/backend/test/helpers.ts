import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HeartbeatResponse,
  type NextTaskResponse,
  type RegisterRunnerResponse,
  type TaskExitedRequest,
  RUNNER_PATHS,
} from "@claude-bridge/protocol";
import { type AppOptions, type BridgeApp, createApp } from "../src/app.js";
import { type ConfigInput, parseConfig } from "../src/config.js";
import type { Clock } from "../src/util/clock.js";
import type { TimerHandle, Timers } from "../src/util/timers.js";

export const T0 = Date.parse("2026-11-11T10:00:00.000Z");

export class FakeClock implements Clock {
  constructor(public t = T0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  advanceSeconds(s: number): void {
    this.t += s * 1000;
  }
}

export const ORIGIN = "https://bridge.example.test";
export const PAIRING_TOKEN = "pairing-token-for-tests-0123456789";
export const BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-0123456789";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bridge-test-"));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface TestContext {
  bridge: BridgeApp;
  clock: FakeClock;
  dir: string;
}

export async function startBridge(
  opts: { dir?: string; clock?: FakeClock; config?: ConfigInput; app?: AppOptions; listen?: boolean } = {},
): Promise<TestContext> {
  const dir = opts.dir ?? tempDir();
  const clock = opts.clock ?? new FakeClock();
  const config = parseConfig(
    {
      port: 0,
      data_dir: dir,
      allowed_origins: [ORIGIN],
      projects: ["SH"],
      repos: [{ name: "sh", path: "D:/repos/sh", project_key: "SH" }],
      pairing_token: PAIRING_TOKEN,
      runner_bootstrap_token: BOOTSTRAP_TOKEN,
      ...opts.config,
    },
    dir,
  );
  const bridge = await createApp(config, { clock, sweepIntervalMs: 0, ...opts.app });
  if (opts.listen) await bridge.listen();
  return { bridge, clock, dir };
}

export interface HttpResult<T> {
  status: number;
  body: T;
}

/** Runner giả lái HTTP API của bus qua fastify.inject. */
export class FakeRunner {
  token: string | null = null;

  constructor(
    private readonly bridge: BridgeApp,
    readonly workerId: string,
    private readonly repo = "sh",
  ) {}

  private async call<T>(method: "GET" | "POST", url: string, payload?: unknown, token = this.token): Promise<HttpResult<T>> {
    const res = await this.bridge.app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
  }

  async register(currentTaskId: string | null = null, bootstrap = BOOTSTRAP_TOKEN): Promise<HttpResult<RegisterRunnerResponse>> {
    const res = await this.call<RegisterRunnerResponse>(
      "POST",
      RUNNER_PATHS.register,
      { worker_id: this.workerId, repo: this.repo, worktree_path: `D:/wt/${this.workerId}`, host: "localhost", current_task_id: currentTaskId },
      bootstrap,
    );
    if (res.status === 200) this.token = res.body.runner_token;
    return res;
  }

  next(wait = 0): Promise<HttpResult<NextTaskResponse | undefined>> {
    return this.call("GET", `${RUNNER_PATHS.next(this.workerId)}?wait=${wait}`);
  }

  heartbeat(currentTaskId: string | null): Promise<HttpResult<HeartbeatResponse>> {
    return this.call("POST", RUNNER_PATHS.heartbeat(this.workerId), { current_task_id: currentTaskId });
  }

  started(taskId: string, sessionId: string | null = "claude-session-1", pid: number | null = 4242): Promise<HttpResult<unknown>> {
    return this.call("POST", RUNNER_PATHS.started(taskId), { session_id: sessionId, pid });
  }

  events(taskId: string, events: unknown[]): Promise<HttpResult<unknown>> {
    return this.call("POST", RUNNER_PATHS.events(taskId), { events });
  }

  exited(taskId: string, body: Partial<TaskExitedRequest> = {}): Promise<HttpResult<unknown>> {
    return this.call("POST", RUNNER_PATHS.exited(taskId), { exit_code: 0, usage: null, ...body });
  }

  /** register → (assign từ ngoài) → next → started; trả task_id + task token. */
  async pickUp(): Promise<NextTaskResponse> {
    const res = await this.next(0);
    if (res.status !== 200 || !res.body) throw new Error(`expected a task for ${this.workerId}, got ${res.status}`);
    return res.body;
  }
}

export async function registerRunners(bridge: BridgeApp, ...ids: string[]): Promise<FakeRunner[]> {
  const runners = ids.map((id) => new FakeRunner(bridge, id));
  for (const r of runners) {
    const res = await r.register();
    if (res.status !== 200) throw new Error(`register ${r.workerId} failed: ${res.status}`);
  }
  return runners;
}

export function busEventTypes(bridge: BridgeApp): string[] {
  return bridge.eventLog.readBusEventsSince(0).map((e) => e.type);
}

/** Timer giả chạy theo FakeClock: `advance` đẩy đồng hồ và gọi các timer đến hạn theo thứ tự thời gian. */
export class FakeTimers implements Timers {
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void; interval: number | null }>();

  constructor(private readonly clock: FakeClock) {}

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, { at: this.clock.now() + ms, fn, interval: null });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, { at: this.clock.now() + ms, fn, interval: ms });
    return id;
  }

  clearInterval(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const end = this.clock.now() + ms;
    for (;;) {
      let nextId: number | null = null;
      let next: { at: number; fn: () => void; interval: number | null } | null = null;
      for (const [id, t] of this.timers) {
        if (t.at <= end && (next === null || t.at < next.at)) {
          nextId = id;
          next = t;
        }
      }
      if (next === null || nextId === null) break;
      this.clock.t = next.at;
      if (next.interval === null) this.timers.delete(nextId);
      else next.at += next.interval;
      next.fn();
    }
    this.clock.t = end;
  }
}

/** Chờ các microtask / I/O ngắn đang dở (luồng message của driver giả là async). */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
