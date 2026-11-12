// Runs backend, runner and web in one console: ordered start with HTTP readiness probes, prefixed + teed output,
// and the Windows console signal model (Ctrl+C reaches every child directly, so the supervisor never forwards it).
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { EXIT, EXIT_HANGUP } from "./errors.mjs";
import { killTree, killTreeSync } from "./proc.mjs";

const PROBE_REQUEST_TIMEOUT_MS = 1_000;
const FORCED_STOP_CAP_MS = 10_000;
/** Supervisor-initiated kills: the runner first so it does not see the bus vanish mid-task. */
const KILL_ORDER = Object.freeze(["runner", "web", "backend"]);
const RUNNER_CONFIG_REJECTED = 2;
const BACKEND_CRASH = 1;

/**
 * @typedef {{ url: string, timeoutMs: number, intervalMs: number }} ReadyProbe
 * @typedef {object} ChildSpec
 * @property {"backend" | "runner" | "web"} name
 * @property {string} command
 * @property {string[]} args
 * @property {string} cwd
 * @property {NodeJS.ProcessEnv} env
 * @property {ReadyProbe} [ready]
 * @typedef {{ on(sig: string, fn: () => void): void, off(sig: string, fn: () => void): void }} SignalSource
 * @typedef {object} SupervisorOptions
 * @property {ChildSpec[]} children started in array order
 * @property {string} logsDir
 * @property {() => string} banner printed once everything is ready
 * @property {number} gracefulTimeoutMs
 * @property {NodeJS.Platform} [platform]
 * @property {SignalSource} [signals]
 * @property {NodeJS.WritableStream} [out]
 * @typedef {((chunk: Buffer) => void) & { flush(): void }} LinePrefixer
 */

/**
 * Splits a byte stream into lines (UTF-8 safe across chunk boundaries) and hands `prefix + line` to `sink`.
 * Call `flush()` at end of stream for a trailing partial line.
 * @param {string} prefix
 * @param {(line: string) => void} sink
 * @returns {LinePrefixer}
 */
export function createLinePrefixer(prefix, sink) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (text) => {
    const parts = text.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) {
      sink(prefix + line.replace(/\r$/, ""));
    }
  };
  const fn = /** @type {LinePrefixer} */ ((chunk) => emit(pending + decoder.write(chunk)));
  fn.flush = () => {
    const rest = pending + decoder.end();
    pending = "";
    if (rest !== "") {
      sink(prefix + rest.replace(/\r$/, ""));
    }
  };
  return fn;
}

/** @param {Date} d */
function dateStamp(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function timeStamp() {
  return new Date().toTimeString().slice(0, 8);
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @typedef {object} Entry
 * @property {ChildSpec} spec
 * @property {import("node:child_process").ChildProcess} child
 * @property {boolean} alive
 * @property {boolean} ready
 * @property {import("node:fs").WriteStream} log
 * @property {LinePrefixer[]} prefixers
 */

class Supervisor {
  /**
   * @param {SupervisorOptions} opts
   * @param {(code: number) => void} resolve
   */
  constructor(opts, resolve) {
    this.opts = opts;
    this.resolve = resolve;
    this.platform = opts.platform ?? process.platform;
    this.signals = opts.signals ?? process;
    this.out = opts.out ?? process.stdout;
    this.date = dateStamp(new Date());
    /** @type {"starting" | "running" | "stopping" | "done"} */
    this.phase = "starting";
    /** @type {"graceful" | "forced" | null} */
    this.mode = null;
    this.code = EXIT.OK;
    /** @type {NodeJS.Timeout | null} */
    this.graceTimer = null;
    /** @type {NodeJS.Timeout | null} */
    this.capTimer = null;
    /** @type {Entry[]} */
    this.entries = [];
    this.labelWidth = Math.max(...opts.children.map((c) => c.name.length)) + 2;
    mkdirSync(opts.logsDir, { recursive: true });
    this.supLog = this.openLog("supervisor");
    this.onInterrupt = () => this.handleInterrupt();
    this.onTerm = () => this.handleTerm();
    this.onHangup = () => this.handleHangup();
    /** @type {[string, () => void][]} */
    this.handlers = [
      ["SIGINT", this.onInterrupt],
      ["SIGHUP", this.onHangup],
      this.platform === "win32" ? ["SIGBREAK", this.onInterrupt] : ["SIGTERM", this.onTerm],
    ];
  }

  start() {
    for (const [sig, fn] of this.handlers) {
      this.signals.on(sig, fn);
    }
    this.spawnFrom(0);
  }

  /** @param {string} name */
  openLog(name) {
    const stream = createWriteStream(path.join(this.opts.logsDir, `${name}-${this.date}.log`), { flags: "a" });
    stream.on("error", () => {
      // A full disk must not take the services down; console output continues.
    });
    return stream;
  }

  /** @param {string} line */
  say(line) {
    this.out.write(`${line}\n`);
    this.supLog.write(`${timeStamp()} ${line}\n`);
  }

  /** @param {number} i */
  spawnFrom(i) {
    if (this.phase !== "starting") {
      return;
    }
    const specs = this.opts.children;
    if (i >= specs.length) {
      this.phase = "running";
      this.say(this.opts.banner());
      return;
    }
    const spec = specs[i];
    this.say(`Đang khởi động ${spec.name}…`);
    const entry = this.spawnChild(spec);
    if (spec.ready === undefined) {
      this.spawnFrom(i + 1);
      return;
    }
    const probe = spec.ready;
    void this.waitReady(entry, probe).then((result) => {
      if (result === "ready") {
        entry.ready = true;
        this.say(`${spec.name} đã sẵn sàng.`);
        this.spawnFrom(i + 1);
      } else if (result === "timeout") {
        this.say(`${spec.name} không sẵn sàng sau ${Math.round(probe.timeoutMs / 1000)} giây.`);
        this.stopForced(EXIT.RUNTIME);
      }
    });
  }

  /** @param {ChildSpec} spec */
  spawnChild(spec) {
    // windowsHide must stay false: with every stdio piped, libuv would add CREATE_NO_WINDOW, the child would get
    // its own hidden console and Ctrl+C in this window would never reach it. Never detached (E-4).
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    /** @type {Entry} */
    const entry = { spec, child, alive: true, ready: false, log: this.openLog(spec.name), prefixers: [] };
    const label = `[${spec.name}]`.padEnd(this.labelWidth);
    for (const stream of [child.stdout, child.stderr]) {
      const toConsole = createLinePrefixer(`${label} `, (line) => this.out.write(`${line}\n`));
      const toLog = createLinePrefixer("", (line) => entry.log.write(`${timeStamp()} ${line}\n`));
      entry.prefixers.push(toConsole, toLog);
      stream?.on("data", (chunk) => {
        toConsole(chunk);
        toLog(chunk);
      });
    }
    child.on("error", (err) => {
      this.say(`Không chạy được ${spec.name}: ${err.message}`);
      this.onChildExit(entry, null);
    });
    child.on("close", (code, signal) => this.onChildExit(entry, code ?? signal));
    this.entries.push(entry);
    return entry;
  }

  /**
   * @param {Entry} entry
   * @param {ReadyProbe} probe
   * @returns {Promise<"ready" | "timeout" | "abandoned">}
   */
  async waitReady(entry, probe) {
    const deadline = Date.now() + probe.timeoutMs;
    while (this.phase === "starting" && entry.alive) {
      try {
        const res = await fetch(probe.url, { signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS) });
        await res.body?.cancel();
        if (res.ok && this.phase === "starting" && entry.alive) {
          return "ready";
        }
      } catch {
        // Not listening yet.
      }
      if (Date.now() >= deadline) {
        return this.phase === "starting" && entry.alive ? "timeout" : "abandoned";
      }
      await delay(probe.intervalMs);
    }
    return "abandoned";
  }

  /**
   * @param {Entry} entry
   * @param {number | string | null} code exit code, or the signal name
   */
  onChildExit(entry, code) {
    if (!entry.alive) {
      return;
    }
    entry.alive = false;
    for (const prefixer of entry.prefixers) {
      prefixer.flush();
    }
    entry.log.write(`${timeStamp()} -- ${entry.spec.name} thoát (mã ${code})\n`);
    if (this.phase === "starting" || this.phase === "running") {
      this.say(`${entry.spec.name} dừng bất ngờ (mã ${code}).`);
      const hint = this.exitHint(entry, code);
      if (hint !== null) {
        this.say(hint);
      }
      this.stopForced(EXIT.RUNTIME);
      return;
    }
    this.finishIfAllExited();
  }

  /**
   * @param {Entry} entry
   * @param {number | string | null} code
   * @returns {string | null}
   */
  exitHint(entry, code) {
    switch (entry.spec.name) {
      case "runner":
        return code === RUNNER_CONFIG_REJECTED
          ? "runner từ chối cấu hình sinh ra (lỗi của mps-bridge — báo người bảo trì kèm logs\\runner-*.log)"
          : "Xem logs\\runner-*.log.";
      case "backend":
        return !entry.ready && code === BACKEND_CRASH
          ? "backend dừng trước khi sẵn sàng, xem logs\\backend-*.log"
          : "Xem logs\\backend-*.log.";
      case "web":
        return "web (vite preview) dừng — thường do cổng giao diện (ports.web) bị chiếm. Xem logs\\web-*.log.";
      default:
        return null;
    }
  }

  handleInterrupt() {
    if (this.phase === "starting" || this.phase === "running") {
      this.say("Đang dừng… (Ctrl+C lần nữa để dừng ngay)");
      this.stopGraceful();
    } else if (this.phase === "stopping" && this.mode === "graceful") {
      this.say("Dừng ngay.");
      this.stopForced(EXIT.FORCED);
    }
  }

  /** POSIX only: a SIGTERM sent to the supervisor alone is forwarded once. */
  handleTerm() {
    if (this.phase !== "starting" && this.phase !== "running") {
      return;
    }
    for (const entry of this.aliveEntries()) {
      entry.child.kill("SIGTERM");
    }
    this.stopGraceful();
  }

  /** Console window closed: Windows allows about 5 s, so kill synchronously. */
  handleHangup() {
    if (this.phase === "done") {
      return;
    }
    for (const entry of this.aliveEntries()) {
      if (entry.child.pid !== undefined) {
        killTreeSync(entry.child.pid);
      }
    }
    this.code = EXIT_HANGUP;
    void this.finish();
  }

  /** Children already received Ctrl+C from the console: send nothing, wait, then force the survivors. */
  stopGraceful() {
    this.phase = "stopping";
    this.mode = "graceful";
    this.code = EXIT.OK;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      const survivors = this.aliveEntries().map((e) => e.spec.name);
      this.say(`Sau ${Math.round(this.opts.gracefulTimeoutMs / 1000)} giây vẫn chưa dừng: ${survivors.join(", ")}. Buộc dừng.`);
      this.stopForced(this.code);
    }, this.opts.gracefulTimeoutMs);
    this.finishIfAllExited();
  }

  /** @param {number} code */
  stopForced(code) {
    if (this.phase === "done" || (this.phase === "stopping" && this.mode === "forced")) {
      return;
    }
    this.phase = "stopping";
    this.mode = "forced";
    this.code = code;
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.capTimer = setTimeout(() => {
      this.say("Một số tiến trình chưa thoát sau khi buộc dừng; bỏ qua.");
      void this.finish();
    }, FORCED_STOP_CAP_MS);
    void this.killAll();
  }

  async killAll() {
    const rank = (name) => {
      const i = KILL_ORDER.indexOf(name);
      return i === -1 ? KILL_ORDER.length : i;
    };
    const targets = this.aliveEntries().sort((a, b) => rank(a.spec.name) - rank(b.spec.name));
    for (const entry of targets) {
      if (entry.alive && entry.child.pid !== undefined) {
        await killTree(entry.child.pid);
      }
    }
    this.finishIfAllExited();
  }

  aliveEntries() {
    return this.entries.filter((e) => e.alive);
  }

  finishIfAllExited() {
    if (this.phase === "stopping" && this.aliveEntries().length === 0) {
      void this.finish();
    }
  }

  async finish() {
    if (this.phase === "done") {
      return;
    }
    this.phase = "done";
    for (const timer of [this.graceTimer, this.capTimer]) {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
    for (const [sig, fn] of this.handlers) {
      this.signals.off(sig, fn);
    }
    this.supLog.write(`${timeStamp()} -- supervisor kết thúc (mã ${this.code})\n`);
    const streams = [this.supLog, ...this.entries.map((e) => e.log)];
    await Promise.all(streams.map((s) => new Promise((done) => s.end(done))));
    this.resolve(this.code);
  }
}

/**
 * Starts the children in order and resolves with the exit code once all of them are gone. Never calls process.exit.
 * @param {SupervisorOptions} opts
 * @returns {Promise<number>}
 */
export function runSupervisor(opts) {
  return new Promise((resolve) => {
    new Supervisor(opts, resolve).start();
  });
}
