// Entry point: đọc cấu hình, khởi động backend, in pairing token (một lần, có chủ đích) và URL.
import { join } from "node:path";
import { BUS_MCP_PATH } from "@claude-bridge/protocol";
import { SERVER_VERSION, createApp } from "./app.js";
import { RUNNER_BOOTSTRAP_TOKEN_FILE } from "./bus/tokens.js";
import { BIND_HOST, ConfigError, loadConfig } from "./config.js";
import { WS_PATH } from "./ws/hub.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const bridge = await createApp(config, { logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const { port } = await bridge.listen();

  const lines = [
    "",
    `claude-bridge backend v${SERVER_VERSION}`,
    `  config        : ${config.config_path ?? "(none, using defaults)"}`,
    `  data dir      : ${config.data_dir}`,
    `  HTTP          : http://${BIND_HOST}:${port}`,
    `  MCP (bus)     : http://${BIND_HOST}:${port}${BUS_MCP_PATH}`,
    `  WebSocket     : ws://${BIND_HOST}:${port}${WS_PATH}`,
    `  runner token  : ${config.runner_bootstrap_token ? "from config / RUNNER_BOOTSTRAP_TOKEN" : join(config.data_dir, RUNNER_BOOTSTRAP_TOKEN_FILE)}`,
    `  origins       : ${config.allowed_origins.length > 0 ? config.allowed_origins.join(", ") : "(none)"}`,
    "",
    `  PAIRING TOKEN : ${bridge.pairingToken}`,
    "  (paste it into the web UI once)",
    "",
  ];
  console.log(lines.join("\n"));
  if (config.allowed_origins.length === 0) {
    console.warn("WARNING: allowed_origins is empty, every WebSocket connection will be rejected. Set ALLOWED_ORIGINS.");
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    bridge.app.log.info({ signal }, "shutting down");
    bridge
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error("shutdown failed:", err);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(`config error: ${err.message}`);
  else console.error("backend failed to start:", err);
  process.exit(1);
});
