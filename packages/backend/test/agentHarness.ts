// Dựng backend thật (listen) với FakeClaudeDriver + FakeTimers cho test Session Manager / Broker / Wake / orchestrator.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BridgeApp } from "../src/app.js";
import { FakeClaudeDriver } from "../src/claude/fakeDriver.js";
import type { ConfigInput } from "../src/config.js";
import type { RestartPolicy } from "../src/sessions/orchestrators.js";
import { FakeClock, FakeTimers, removeDir, startBridge, tempDir } from "./helpers.js";
import { type TestWs, openSubscribed } from "./wsClient.js";

export interface AgentHarness {
  bridge: BridgeApp;
  driver: FakeClaudeDriver;
  clock: FakeClock;
  timers: FakeTimers;
  dir: string;
  /** Thư mục repo duy nhất trong whitelist (tên `sh`, project SH). */
  repoDir: string;
  orchestratorDir: string;
  sockets: TestWs[];
  open(): Promise<TestWs>;
  /** Đóng backend (giữ thư mục để mở lại cùng DB). */
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  dir?: string;
  clock?: FakeClock;
  config?: ConfigInput;
  withOrchestrator?: boolean;
  restartPolicy?: RestartPolicy;
}

export async function startAgentHarness(opts: HarnessOptions = {}): Promise<AgentHarness> {
  const dir = opts.dir ?? tempDir();
  const repoDir = join(dir, "repo-sh");
  const orchestratorDir = join(dir, "orch-sh");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(orchestratorDir, { recursive: true });
  const clock = opts.clock ?? new FakeClock();
  const timers = new FakeTimers(clock);
  const driver = new FakeClaudeDriver();
  const { bridge } = await startBridge({
    dir,
    clock,
    listen: true,
    config: {
      repos: [{ name: "sh", path: repoDir, project_key: "SH" }],
      projects: ["SH"],
      ...(opts.withOrchestrator ? { orchestrators: { SH: { cwd: orchestratorDir } } } : {}),
      ...opts.config,
    },
    app: { claudeDriver: driver, timers, ...(opts.restartPolicy ? { orchestratorRestartPolicy: opts.restartPolicy } : {}) },
  });
  const sockets: TestWs[] = [];
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const s of sockets.splice(0)) s.close();
    await bridge.close();
  };
  return {
    bridge,
    driver,
    clock,
    timers,
    dir,
    repoDir,
    orchestratorDir,
    sockets,
    async open() {
      const ws = await openSubscribed(bridge.baseUrl());
      sockets.push(ws);
      return ws;
    },
    stop,
    async dispose() {
      await stop();
      removeDir(dir);
    },
  };
}
