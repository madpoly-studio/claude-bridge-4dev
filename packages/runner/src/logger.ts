// Structured, one-line logging with [worker][task] prefixes. Never pass tokens or MCP config content here.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** New logger whose lines carry an extra `[prefix]`. */
  child(prefix: string): Logger;
}

export type LogSink = (level: LogLevel, line: string) => void;

const defaultSink: LogSink = (level, line) => {
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
};

function formatFields(fields: LogFields | undefined): string {
  if (!fields) {
    return "";
  }
  let out = "";
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    const text = typeof value === "string" && /[\s"=]/.test(value) ? JSON.stringify(value) : String(value);
    out += ` ${key}=${text}`;
  }
  return out;
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return fallback;
}

export function createLogger(options: { level?: LogLevel; sink?: LogSink; prefixes?: string[] } = {}): Logger {
  const minLevel = LEVEL_ORDER[options.level ?? "info"];
  const sink = options.sink ?? defaultSink;
  const prefixes = options.prefixes ?? [];
  const prefixText = prefixes.map((p) => `[${p}]`).join("");

  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < minLevel) {
      return;
    }
    const head = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)}`;
    sink(level, `${head} ${prefixText}${prefixText ? " " : ""}${message}${formatFields(fields)}`);
  };

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (prefix) => createLogger({ level: options.level, sink, prefixes: [...prefixes, prefix] }),
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return `${err.message}${cause}`;
  }
  return String(err);
}
