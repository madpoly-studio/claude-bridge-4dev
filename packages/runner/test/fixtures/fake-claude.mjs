#!/usr/bin/env node
// Fake `claude -p --output-format stream-json --verbose` for runner tests and the bus end-to-end test.
// Dependency-free. Run as: claude_command = [process.execPath, "<abs path>/fake-claude.mjs"].
//
// Reads the prompt from stdin, prints stream-json lines, and (mode "complete") calls the bus MCP tool
// with raw JSON-RPC over HTTP, using the url + Authorization header from the --mcp-config file.
//
// Env:
//   FAKE_CLAUDE_MODE         complete (default) | hang | crash
//   FAKE_CLAUDE_TOOL         complete_task (default) | fail_task | none   (mode complete)
//   FAKE_CLAUDE_TOOL_ARGS    JSON object overriding the tool arguments
//   FAKE_CLAUDE_EXTRA_LINES  number of extra assistant lines to print (default 0)
//   FAKE_CLAUDE_NO_INIT      "1" = never print the system/init line
//   FAKE_CLAUDE_DELAY_MS     delay between lines (default 0)
//   FAKE_CLAUDE_GRANDCHILD   "1" = spawn a long-lived grandchild that inherits stdout and outlives this process
//                            (process tree kill / leftover reaping tests)
//   FAKE_CLAUDE_RECORD_FILE  write {argv, prompt, mcp_config_path, mcp_config_existed, pid, grandchild_pid} here
//   FAKE_CLAUDE_EXIT_CODE    exit code for mode crash (default 3)
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const SERVER_NAME = "bridge-bus";
const env = process.env;
const mode = env.FAKE_CLAUDE_MODE ?? "complete";
const delayMs = Number(env.FAKE_CLAUDE_DELAY_MS ?? "0");
const sessionId = randomUUID();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = async (obj) => {
  process.stdout.write(`${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`);
  if (delayMs > 0) {
    await sleep(delayMs);
  }
};

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function loadBusServer(configPath) {
  if (!configPath || !existsSync(configPath)) {
    return null;
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const server = config?.mcpServers?.[SERVER_NAME];
  return server?.url ? { url: server.url, headers: server.headers ?? {} } : null;
}

/** JSON or SSE (text/event-stream) JSON-RPC response → the message with our id. */
async function readRpcResponse(res, id) {
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg.id === id) {
          return msg;
        }
      }
    }
    throw new Error(`no JSON-RPC response with id ${id} in SSE body`);
  }
  return text ? JSON.parse(text) : null;
}

async function callBusTool(server, name, args) {
  const baseHeaders = {
    ...server.headers,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  let sessionHeader = {};
  const post = async (body) => {
    const res = await fetch(server.url, { method: "POST", headers: { ...baseHeaders, ...sessionHeader }, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) {
      sessionHeader = { "mcp-session-id": sid };
    }
    return res;
  };

  // initialize is harmless for a stateless server and required by a stateful one.
  const init = await post({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1.0.0" } },
  });
  if (init.ok) {
    await readRpcResponse(init, 0).catch(() => null);
    const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await notified.text();
  } else {
    await init.text();
  }

  const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  if (!res.ok) {
    throw new Error(`tools/call ${name} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const msg = await readRpcResponse(res, 1);
  if (msg?.error) {
    throw new Error(`tools/call ${name} -> JSON-RPC error ${msg.error.code}: ${msg.error.message}`);
  }
  if (msg?.result?.isError) {
    throw new Error(`tools/call ${name} -> tool error: ${JSON.stringify(msg.result.content ?? null).slice(0, 300)}`);
  }
  return msg?.result ?? null;
}

function defaultToolArgs(tool) {
  if (tool === "fail_task") {
    return { category: "other", reason: "fake claude failed on purpose" };
  }
  return { mr_url: "https://gitlab.example.com/group/repo/-/merge_requests/1", branch: "fake/branch", summary: "fake claude done" };
}

async function main() {
  const prompt = await readStdin();
  const mcpConfigPath = argValue("--mcp-config");
  const server = loadBusServer(mcpConfigPath);

  let grandchildPid = null;
  if (env.FAKE_CLAUDE_GRANDCHILD === "1") {
    // Like a dev server started from claude's Bash tool: it holds claude's stdout open and outlives claude.
    // win32: detached keeps it out of the kill-on-close job object Node puts its children in (the real claude
    // does not kill its children on exit). Not on POSIX, where detached would also leave the process group.
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "inherit", "ignore"],
      detached: process.platform === "win32",
    });
    grandchild.unref();
    grandchildPid = grandchild.pid ?? null;
  }
  if (env.FAKE_CLAUDE_RECORD_FILE) {
    writeFileSync(
      env.FAKE_CLAUDE_RECORD_FILE,
      JSON.stringify({
        argv: process.argv.slice(2),
        prompt,
        cwd: process.cwd(),
        mcp_config_path: mcpConfigPath ?? null,
        mcp_config_existed: Boolean(mcpConfigPath && existsSync(mcpConfigPath)),
        has_bootstrap_token_env: "RUNNER_BOOTSTRAP_TOKEN" in env,
        pid: process.pid,
        grandchild_pid: grandchildPid,
      }),
    );
  }

  // Real CLI prints SessionStart hook lines before init.
  await emit({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup", session_id: sessionId });
  if (env.FAKE_CLAUDE_NO_INIT !== "1") {
    await emit({
      type: "system",
      subtype: "init",
      cwd: process.cwd(),
      session_id: sessionId,
      tools: ["Read", "Edit"],
      mcp_servers: [{ name: SERVER_NAME, status: server ? "connected" : "failed" }],
      model: "fake-model",
      permissionMode: argValue("--permission-mode") ?? "default",
    });
  }
  await emit({
    type: "assistant",
    session_id: sessionId,
    message: { role: "assistant", content: [{ type: "text", text: `Working on: ${prompt.split("\n")[0] ?? ""}` }] },
  });
  await emit("fake-claude: this line is not JSON");
  const extra = Number(env.FAKE_CLAUDE_EXTRA_LINES ?? "0");
  for (let i = 0; i < extra; i++) {
    await emit({ type: "assistant", session_id: sessionId, seq: i, message: { role: "assistant", content: [{ type: "text", text: `step ${i}` }] } });
  }

  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "crash") {
    process.stderr.write("fatal: simulated crash in fake claude\n");
    process.exitCode = Number(env.FAKE_CLAUDE_EXIT_CODE ?? "3");
    return;
  }

  const tool = env.FAKE_CLAUDE_TOOL ?? "complete_task";
  let isError = false;
  let resultText = "done";
  if (tool !== "none") {
    const args = env.FAKE_CLAUDE_TOOL_ARGS ? JSON.parse(env.FAKE_CLAUDE_TOOL_ARGS) : defaultToolArgs(tool);
    const toolUseId = `toolu_${randomUUID()}`;
    const fullName = `mcp__${SERVER_NAME}__${tool}`;
    await emit({
      type: "assistant",
      session_id: sessionId,
      message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: fullName, input: args }] },
    });
    try {
      if (!server) {
        throw new Error(`no "${SERVER_NAME}" server in --mcp-config`);
      }
      const result = await callBusTool(server, tool, args);
      await emit({
        type: "user",
        session_id: sessionId,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result?.content ?? [] }] },
      });
    } catch (err) {
      isError = true;
      resultText = String(err?.message ?? err);
      process.stderr.write(`fake-claude: ${resultText}\n`);
      await emit({
        type: "user",
        session_id: sessionId,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: true, content: resultText }] },
      });
    }
  }

  await emit({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    session_id: sessionId,
    num_turns: 2,
    result: resultText,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
  });
  process.exitCode = isError ? 1 : 0;
}

main().catch((err) => {
  process.stderr.write(`fake-claude crashed: ${err?.stack ?? err}\n`);
  process.exitCode = 70;
});
