#!/usr/bin/env node
// CLI entry: `runner [--config <file>] [--worker <worker_id>]`.
import { parseArgs } from "node:util";
import { ConfigError, DEFAULT_CONFIG_FILE, loadConfig } from "./config.js";
import { createLogger, errorMessage, parseLogLevel } from "./logger.js";
import { UnknownWorkerError, runSlots } from "./runner.js";

const USAGE = `Usage: claude-bridge-runner [--config <path>] [--worker <worker_id>]

  --config   runner config file (default: env RUNNER_CONFIG, else ./${DEFAULT_CONFIG_FILE})
  --worker   run only this slot (default: every slot in the config)

Env: RUNNER_BOOTSTRAP_TOKEN (else bootstrap_token_file), RUNNER_LOG_LEVEL=debug|info|warn|error`;

const EXIT_USAGE = 2;
const EXIT_SIGINT = 130;

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        config: { type: "string" },
        worker: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`${errorMessage(err)}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (parsed.values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const logger = createLogger({ level: parseLogLevel(process.env.RUNNER_LOG_LEVEL, "info") });
  const configPath = parsed.values.config ?? process.env.RUNNER_CONFIG ?? DEFAULT_CONFIG_FILE;

  const shutdown = new AbortController();
  let signalCount = 0;
  const onSignal = (signal: NodeJS.Signals): void => {
    signalCount += 1;
    if (signalCount > 1) {
      logger.warn("second signal, exiting immediately", { signal });
      process.exit(EXIT_SIGINT);
    }
    logger.info("shutting down: stopping running tasks", { signal });
    shutdown.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const config = await loadConfig(configPath);
    await runSlots(config, { workerId: parsed.values.worker, signal: shutdown.signal, logger });
    return 0;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof UnknownWorkerError) {
      logger.error(err.message);
      return EXIT_USAGE;
    }
    logger.error("runner failed", { error: errorMessage(err) });
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`fatal: ${errorMessage(err)}\n`);
    process.exit(1);
  },
);
