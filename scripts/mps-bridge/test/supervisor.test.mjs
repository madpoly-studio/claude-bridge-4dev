import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createLinePrefixer, runSupervisor } from "../lib/supervisor.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const logsRoot = mkdtempSync(path.join(tmpdir(), "mpsb-sup-"));
after(() => rmSync(logsRoot, { recursive: true, force: true, maxRetries: 3 }));

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
}

/** Fake SignalSource: tests fire signals by hand. */
function fakeSignals() {
  /** @type {Map<string, Set<() => void>>} */
  const handlers = new Map();
  return {
    on: (sig, fn) => handlers.set(sig, new Set([...(handlers.get(sig) ?? []), fn])),
    off: (sig, fn) => handlers.get(sig)?.delete(fn),
    emit: (sig) => [...(handlers.get(sig) ?? [])].forEach((fn) => fn()),
    count: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

/**
 * @param {any} name
 * @param {string} fixture
 * @param {string[]} args
 * @param {number} [readyPort]
 */
function child(name, fixture, args, readyPort) {
  return {
    name,
    command: process.execPath,
    args: [path.join(FIXTURES, fixture), ...args],
    cwd: FIXTURES,
    env: process.env,
    ...(readyPort === undefined ? {} : { ready: { url: `http://127.0.0.1:${readyPort}/`, timeoutMs: 10_000, intervalMs: 50 } }),
  };
}

function capture() {
  const out = new PassThrough();
  let text = "";
  out.on("data", (c) => { text += c.toString("utf8"); });
  return { out, text: () => text };
}

/** Resolves once `predicate(text)` holds. */
async function waitForText(cap, predicate, timeoutMs = 10_000) {
  const start = Date.now();
  while (!predicate(cap.text())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout; output so far:\n${cap.text()}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** @param {Partial<import("../lib/supervisor.mjs").SupervisorOptions>} opts */
function supervise(opts, cap, signals = fakeSignals()) {
  const logsDir = mkdtempSync(path.join(logsRoot, "run-"));
  return {
    signals,
    logsDir,
    done: runSupervisor({
      children: [],
      logsDir,
      banner: () => "BANNER",
      gracefulTimeoutMs: 20_000,
      signals,
      out: cap.out,
      ...opts,
    }),
  };
}

describe("runSupervisor", () => {
  it("starts children in order, each after the previous one is ready, then prints the banner", async () => {
    const [p1, p2] = [await freePort(), await freePort()];
    const cap = capture();
    const run = supervise({ children: [child("backend", "http-ok.mjs", [String(p1), "300"], p1), child("web", "http-ok.mjs", [String(p2)], p2)] }, cap);
    await waitForText(cap, (t) => t.includes("BANNER"));
    const t = cap.text();
    assert.ok(t.indexOf(`[backend] listening ${p1}`) < t.indexOf("[web]     started"), t);
    assert.ok(t.indexOf("[web]     started") < t.indexOf("BANNER"));
    assert.deepEqual(readdirSync(run.logsDir).map((f) => f.replace(/-\d{8}\.log$/, "")).sort(), ["backend", "supervisor", "web"]);
    run.signals.emit("SIGINT");
    run.signals.emit("SIGINT");
    assert.equal(await run.done, 130);
  });

  it("a child that exits kills the others and resolves 1", async () => {
    const cap = capture();
    const run = supervise({ children: [child("runner", "sleep.mjs", []), child("web", "exit-after.mjs", ["200", "4"])] }, cap);
    assert.equal(await run.done, 1);
    assert.match(cap.text(), /web dừng bất ngờ \(mã 4\)/);
    assert.equal(run.signals.count(), 0, "signal handlers are removed");
  });

  it("probe timeout resolves 1", async () => {
    const port = await freePort();
    const cap = capture();
    const spec = { ...child("backend", "sleep.mjs", []), ready: { url: `http://127.0.0.1:${port}/`, timeoutMs: 1_000, intervalMs: 50 } };
    const run = supervise({ children: [spec] }, cap);
    assert.equal(await run.done, 1);
    assert.match(cap.text(), /backend không sẵn sàng sau 1 giây/);
  });

  it("SIGINT forwards nothing; survivors are force-killed after the graceful timeout and the code is 0", async () => {
    const cap = capture();
    const run = supervise({ children: [child("runner", "sleep.mjs", [])], gracefulTimeoutMs: 300 }, cap);
    await waitForText(cap, (t) => t.includes("BANNER"));
    run.signals.emit("SIGINT");
    assert.equal(await run.done, 0);
    const t = cap.text();
    assert.ok(t.includes("Đang dừng…"));
    assert.ok(!t.includes("got SIGINT"), "the supervisor must not forward SIGINT");
    assert.ok(t.includes("vẫn chưa dừng: runner"));
  });

  it("second SIGINT stops at once with 130", async () => {
    const cap = capture();
    const run = supervise({ children: [child("runner", "sleep.mjs", [])] }, cap);
    await waitForText(cap, (t) => t.includes("BANNER"));
    run.signals.emit("SIGINT");
    run.signals.emit("SIGINT");
    assert.equal(await run.done, 130);
  });
});

describe("createLinePrefixer", () => {
  it("handles lines split across chunks, CRLF and multi-byte characters", () => {
    const lines = [];
    const prefixer = createLinePrefixer("[x] ", (l) => lines.push(l));
    const bytes = Buffer.from("Đang chạy\r\nhai", "utf8");
    prefixer(bytes.subarray(0, 1));
    prefixer(bytes.subarray(1, 12));
    prefixer(bytes.subarray(12));
    assert.deepEqual(lines, ["[x] Đang chạy"]);
    prefixer(Buffer.from(" ba\nbốn"));
    assert.deepEqual(lines, ["[x] Đang chạy", "[x] hai ba"]);
    prefixer.flush();
    assert.deepEqual(lines, ["[x] Đang chạy", "[x] hai ba", "[x] bốn"]);
  });
});
