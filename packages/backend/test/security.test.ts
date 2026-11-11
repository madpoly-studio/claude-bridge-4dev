// Review fixes (system design §7.6, §12): no secret in the Claude child's argv, planner path sandbox, planner settings
// sources, secret files, per-project orchestrator tokens, http(s)-only MR URLs.
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BUS_MCP_SERVER_NAME } from "@claude-bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBusTools, callBusTool } from "../src/bus/mcpTools.js";
import type { ClaudeSessionOptions } from "../src/claude/driver.js";
import type { FakeToolOutcome } from "../src/claude/fakeDriver.js";
import { McpConfigFiles } from "../src/claude/mcpConfigFile.js";
import { RepoPathGuard, isSecretFileName } from "../src/claude/repoPathGuard.js";
import { type QueryFn, SdkClaudeDriver } from "../src/claude/sdkDriver.js";
import { type BridgeConfig, ConfigError, parseConfig } from "../src/config.js";
import type { PermissionBroker } from "../src/permissions/permissionBroker.js";
import { SessionProfiles } from "../src/sessions/profiles.js";
import { AsyncQueue } from "../src/util/asyncQueue.js";
import { type AgentHarness, startAgentHarness } from "./agentHarness.js";
import { type TestContext, registerRunners, removeDir, startBridge, tempDir } from "./helpers.js";

const BUS_TOKEN = "orch-token-SECRET-0123456789abcdef";
const JIRA_PAT = "jira-pat-SECRET-abcdef0123456789";
const HEADER_SECRET = "header-SECRET-9876543210";

/** Query giả: luồng message do test điều khiển. */
function fakeQuery(): { query: Query; messages: AsyncQueue<SDKMessage> } {
  const messages = new AsyncQueue<SDKMessage>();
  const query = Object.assign(messages, {
    interrupt: async () => undefined,
    close: () => messages.end(),
  }) as unknown as Query;
  return { query, messages };
}

/** Mọi option có thể thành argv của CLI (env đi qua biến môi trường, callback ở lại trong process Node). */
function argvBound(options: Record<string, unknown>): string {
  const { env: _env, stderr: _stderr, canUseTool: _canUseTool, hooks: _hooks, ...rest } = options;
  return JSON.stringify(rest);
}

describe("H1: no secret reaches the Claude CLI command line", () => {
  let dir: string;
  afterEach(() => removeDir(dir));

  function profiles(): { p: SessionProfiles; config: BridgeConfig } {
    const config = parseConfig(
      {
        projects: ["SH"],
        repos: [{ name: "sh", path: join(dir, "repo"), project_key: "SH" }],
        planner: {
          mcp_servers: {
            jira: { command: "uvx", args: ["mcp-atlassian"], env: { JIRA_PERSONAL_TOKEN: JIRA_PAT } },
            remote: { type: "http", url: "https://mcp.example.test/mcp", headers: { "X-Api-Key": HEADER_SECRET } },
          },
        },
        orchestrators: {
          SH: { cwd: join(dir, "orch"), mcp_servers: { jira: { command: "uvx", env: { JIRA_PERSONAL_TOKEN: JIRA_PAT } } } },
        },
      },
      dir,
    );
    const p = new SessionProfiles({
      config,
      broker: {} as PermissionBroker,
      mcpUrl: () => "http://127.0.0.1:1/mcp",
      orchestratorToken: (project) => `${BUS_TOKEN}-${project}`,
    });
    return { p, config };
  }

  it("SdkClaudeDriver passes MCP servers as a private temp file, never inline, and deletes it when the process ends", async () => {
    dir = tempDir();
    const files = new McpConfigFiles(join(dir, "data"), dir);
    const { p, config } = profiles();
    const cases: [string, ClaudeSessionOptions, string[]][] = [
      ["orchestrator", p.orchestrator("SH", config.orchestrators.SH!), [`${BUS_TOKEN}-SH`, JIRA_PAT]],
      ["planner", p.planner("s-1", join(dir, "repo")), [JIRA_PAT, HEADER_SECRET]],
    ];
    for (const [role, options, secrets] of cases) {
      // Chính profile vẫn mang secret (trong bộ nhớ); driver là nơi duy nhất dựng argv.
      expect(JSON.stringify(options.mcpServers)).toContain(secrets[0]);
      const fake = fakeQuery();
      const queryFn = vi.fn<QueryFn>(() => fake.query);
      const driver = new SdkClaudeDriver({
        authMode: "subscription",
        executable: null,
        clientApp: "test/1",
        mcpConfigFiles: files,
        log: { warn: () => undefined, debug: () => undefined },
        baseEnv: { PATH: "p" },
        queryFn,
      });
      const handle = driver.start(options);
      const passed = queryFn.mock.calls[0]![0].options as Record<string, unknown>;
      const argv = argvBound(passed);
      for (const secret of secrets) expect(argv, `${role} argv`).not.toContain(secret);
      expect(passed.mcpServers, role).toBeUndefined();
      expect(passed.strictMcpConfig, role).toBe(true);
      const file = (passed.extraArgs as Record<string, string>)["mcp-config"]!;
      const content = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
      expect(content.mcpServers).toEqual(options.mcpServers);
      if (role === "orchestrator") {
        expect(content.mcpServers[BUS_MCP_SERVER_NAME]).toMatchObject({ headers: { Authorization: `Bearer ${BUS_TOKEN}-SH` } });
      }
      if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);

      const consumed = (async () => {
        for await (const _m of handle.messages) void _m;
      })();
      fake.messages.end();
      await consumed;
      expect(existsSync(file), `${role} file removed`).toBe(false);
      // Process đã thoát: turn mới không được nhận im lặng.
      expect(handle.send("late")).toBe(false);
    }
  });

  it("removes stale MCP config files of this backend only", () => {
    dir = tempDir();
    const mine = new McpConfigFiles(join(dir, "data-a"), dir);
    const other = new McpConfigFiles(join(dir, "data-b"), dir);
    const a = mine.write({ x: { command: "c" } });
    const b = other.write({ x: { command: "c" } });
    expect(mine.removeStale()).toBe(1);
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
    b.dispose();
    expect(existsSync(b.path)).toBe(false);
  });
});

describe("H2/M3: planner path sandbox", () => {
  let dir: string;
  afterEach(() => removeDir(dir));

  function setup(): { repo: string; guard: RepoPathGuard } {
    dir = tempDir();
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(dir, "repo-evil"), { recursive: true });
    mkdirSync(join(dir, "outside"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "x");
    writeFileSync(join(dir, "outside", "secret.txt"), "s");
    return { repo, guard: new RepoPathGuard(repo) };
  }

  it("allows reads inside the repo and denies everything that resolves outside it", () => {
    const { repo, guard } = setup();
    expect(guard.check("Read", { file_path: join(repo, "src", "a.ts") })).toBeNull();
    expect(guard.check("Read", { file_path: "src/a.ts" })).toBeNull();
    expect(guard.check("Read", { file_path: "src/missing/new.ts" })).toBeNull();
    expect(guard.check("Grep", { pattern: "x" })).toBeNull();
    expect(guard.check("Glob", { pattern: "src/**/*.ts" })).toBeNull();
    expect(guard.check("Grep", { pattern: "x", path: "src", glob: "*.ts" })).toBeNull();
    if (process.platform === "win32") expect(guard.check("Read", { file_path: join(repo, "SRC", "A.TS").toUpperCase() })).toBeNull();

    const denied: [string, Record<string, unknown>][] = [
      ["Read", { file_path: join(dir, "outside", "secret.txt") }],
      ["Read", { file_path: "../outside/secret.txt" }],
      ["Read", { file_path: join(dir, "repo-evil", "x.txt") }], // tiền tố chung, không phải con
      ["Read", { file_path: "~/.ssh/config" }],
      ["Read", { file_path: "$HOME/.bashrc" }],
      ["Read", { file_path: "%USERPROFILE%\\x" }],
      ["Grep", { pattern: "x", path: join(dir, "outside") }],
      ["Grep", { pattern: "x", glob: "../**" }],
      ["Glob", { pattern: "x", path: dir }],
      ["Glob", { pattern: "../outside/*" }],
      ["Glob", { pattern: join(dir, "outside", "*") }],
      ["Read", { file_path: 42 }],
    ];
    for (const [tool, input] of denied) expect(guard.check(tool, input), JSON.stringify(input)).not.toBeNull();
    // MCP tool (Jira) không có đường dẫn cục bộ.
    expect(guard.check("mcp__jira__jira_get_issue", { path: "/etc/passwd" })).toBeNull();
  });

  it("follows links that point outside the repo", () => {
    const { repo, guard } = setup();
    // Junction không cần quyền admin trên Windows.
    symlinkSync(join(dir, "outside"), join(repo, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(guard.check("Read", { file_path: "link/secret.txt" })).toMatch(/outside/);
    expect(guard.check("Read", { file_path: "link/not-there.txt" })).toMatch(/outside/);
    expect(guard.check("Grep", { pattern: "x", path: "link" })).toMatch(/outside/);
  });

  it("denies secret-looking files inside the repo", () => {
    const { guard } = setup();
    for (const name of [".env", ".ENV", ".env.local", "server.pem", "tls.key", "id_rsa", "id_ed25519.pub", ".npmrc", ".netrc", "credentials.json"]) {
      expect(isSecretFileName(name), name).toBe(true);
      expect(guard.check("Read", { file_path: `config/${name}` }), name).toMatch(/secret/);
    }
    for (const name of ["env.ts", "keys.ts", "README.md", "environment.md"]) expect(isSecretFileName(name), name).toBe(false);
    expect(guard.check("Grep", { pattern: "x", path: ".env" })).toMatch(/secret/);
    if (process.platform === "win32") expect(guard.check("Read", { file_path: ".env::$DATA" })).not.toBeNull();
  });

  describe("through the planner profile", () => {
    let h: AgentHarness;
    afterEach(async () => {
      await h?.dispose();
    });

    it("the PreToolUse hook denies outside and secret reads; canUseTool applies the same guard", async () => {
      h = await startAgentHarness();
      writeFileSync(join(h.repoDir, "a.ts"), "x");
      const ws = await h.open();
      const ack = await ws.request("session.create", { role: "planner", repo: "sh" });
      const sid = ack.payload.result.session.session_id as string;
      const outcomes: Record<string, FakeToolOutcome> = {};
      h.driver.script = async (turn) => {
        // Không có blockedPath: CLI thật có thể không đặt, hook vẫn phải chặn.
        outcomes.outside = await turn.useTool("Read", { file_path: join(h.dir, "orch-sh", "x.md") });
        outcomes.env = await turn.useTool("Read", { file_path: ".env" });
        outcomes.inside = await turn.useTool("Read", { file_path: "a.ts" });
      };
      await ws.request("session.send", { session_id: sid, text: "go" });
      await vi.waitFor(() => expect(Object.keys(outcomes)).toHaveLength(3));
      expect(outcomes.outside).toMatchObject({ allowed: false, decided_by: "hook", message: expect.stringMatching(/outside/) });
      expect(outcomes.env).toMatchObject({ allowed: false, decided_by: "hook", message: expect.stringMatching(/secret/) });
      expect(outcomes.inside).toMatchObject({ allowed: true, decided_by: "auto" });

      const opts = h.driver.last().options;
      expect(opts.allowedTools).not.toContain("Read");
      expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Read(**/.env)", "Read(**/.env.*)", "Read(**/*.pem)"]));
      // CLI 2.1.322 có thể hỏi cả đọc trong repo (không blockedPath): canUseTool quyết định bằng cùng guard, không tin blockedPath.
      const ask = (tool: string, input: Record<string, unknown>, blockedPath?: string) =>
        opts.canUseTool?.(tool, input, {
          signal: new AbortController().signal,
          toolUseID: "t",
          requestId: "r",
          ...(blockedPath !== undefined ? { blockedPath } : {}),
        });
      expect(await ask("Read", { file_path: "a.ts" })).toMatchObject({ behavior: "allow" });
      expect(await ask("Grep", { pattern: "x" })).toMatchObject({ behavior: "allow" });
      expect(await ask("Glob", { pattern: "**/*.ts" })).toMatchObject({ behavior: "allow" });
      expect(await ask("Read", { file_path: join(h.dir, "orch-sh", "x.md") })).toMatchObject({ behavior: "deny" });
      expect(await ask("Read", { file_path: ".env" })).toMatchObject({ behavior: "deny" });
      expect(await ask("Glob", { pattern: "../*" })).toMatchObject({ behavior: "deny" });
      // Input trông như trong repo nhưng CLI báo đường dẫn thật nằm ngoài: từ chối.
      expect(await ask("Read", { file_path: "a.ts" }, join(h.dir, "orch-sh", "x.md"))).toMatchObject({ behavior: "deny" });
    });
  });
});

describe("M2/M3: config", () => {
  it("rejects project/local setting sources for the planner, keeps them for orchestrators", () => {
    for (const sources of [["project"], ["local"], ["user", "project"]]) {
      expect(() => parseConfig({ planner: { setting_sources: sources } }, "D:/x")).toThrow(/planner\.setting_sources/);
    }
    expect(parseConfig({ planner: { setting_sources: ["user"] } }, "D:/x").planner.setting_sources).toEqual(["user"]);
    const cfg = parseConfig({ projects: ["SH"], orchestrators: { SH: { cwd: "o", setting_sources: ["project", "local"] } } }, "D:/x");
    expect(cfg.orchestrators.SH?.setting_sources).toEqual(["project", "local"]);
  });

  it("rejects a jira_env_file inside any whitelisted repo", () => {
    const repos = [
      { name: "a", path: "D:/repos/a" },
      { name: "b", path: "D:/repos/b" },
    ];
    expect(() => parseConfig({ repos, jira_env_file: "D:/repos/b/.env" }, "D:/x")).toThrow(ConfigError);
    expect(() => parseConfig({ repos, jira_env_file: "D:/repos/a/sub/team.env" }, "D:/x")).toThrow(/inside repo "a"/);
    if (process.platform === "win32") expect(() => parseConfig({ repos, jira_env_file: "d:\\REPOS\\A\\.env" }, "D:/x")).toThrow(ConfigError);
    expect(parseConfig({ repos, jira_env_file: "D:/repos/a-secrets/.env" }, "D:/x").jira_env_file).toMatch(/a-secrets/);
  });
});

describe("L1: one orchestrator token per project", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx?.bridge.close();
    if (ctx) removeDir(ctx.dir);
  });

  async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value: any }> {
    const res = await fetch(ctx.bridge.mcpUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { isError: body.result.isError === true, value: JSON.parse(body.result.content[0]!.text) };
  }

  it("scopes assign/cancel/list to the token's project; list_workers is shared", async () => {
    ctx = await startBridge({ listen: true, config: { projects: ["SH", "OT"], max_concurrency: 5 } });
    await registerRunners(ctx.bridge, "w-1", "w-2", "w-3");
    const sh = ctx.bridge.tokens.getOrchestratorToken("SH");
    const ot = ctx.bridge.tokens.getOrchestratorToken("OT");
    expect(sh).not.toBe(ot);
    expect(() => (ctx.bridge.tokens.getOrchestratorToken as (p?: string) => string)()).toThrow(/project key is required/);

    expect((await callTool(sh, "list_workers", {})).value).toHaveLength(3);
    const shTask = await callTool(sh, "assign_task", { worker_id: "w-1", ticket_key: "SH-1" });
    expect(shTask.isError).toBe(false);
    const otTask = await callTool(ot, "assign_task", { worker_id: "w-2", ticket_key: "OT-7" });
    expect(otTask.isError).toBe(false);

    for (const key of ["OT-8", "SHX-1"]) {
      expect(await callTool(sh, "assign_task", { worker_id: "w-3", ticket_key: key })).toMatchObject({
        isError: true,
        value: { error: { code: "FORBIDDEN" } },
      });
    }
    expect(await callTool(sh, "cancel_task", { task_id: otTask.value.task_id, reason: "x" })).toMatchObject({
      isError: true,
      value: { error: { code: "FORBIDDEN" } },
    });
    expect(ctx.bridge.bus.getTask(otTask.value.task_id)?.state).toBe("assigned");
    expect((await callTool(sh, "list_tasks", {})).value.map((t: { ticket_key: string }) => t.ticket_key)).toEqual(["SH-1"]);
    expect((await callTool(sh, "list_tasks", { ticket_key: "OT-7" })).value).toEqual([]);
    expect((await callTool(ot, "cancel_task", { task_id: otTask.value.task_id, reason: "x" })).isError).toBe(false);
  });

  it("complete_task accepts only http(s) MR URLs", async () => {
    ctx = await startBridge();
    const tools = buildBusTools(ctx.bridge.bus);
    const worker = { role: "worker", task_id: "t-none" } as const;
    for (const url of ["javascript:alert(1)", "JavaScript:alert(document.cookie)", "data:text/html,x", "file:///etc/passwd"]) {
      const res = callBusTool(tools, worker, "complete_task", { mr_url: url, branch: "b", summary: "s" });
      expect(res.isError, url).toBe(true);
      expect(JSON.parse(res.content[0]!.text)).toMatchObject({ error: { code: "INVALID_INPUT" } });
    }
    // URL hợp lệ đi qua validate và tới bus (task không tồn tại → lỗi nghiệp vụ khác INVALID_INPUT).
    const ok = callBusTool(tools, worker, "complete_task", { mr_url: "https://gitlab.example/x/-/merge_requests/1", branch: "b", summary: "s" });
    expect(JSON.parse(ok.content[0]!.text).error.code).not.toBe("INVALID_INPUT");
  });
});
