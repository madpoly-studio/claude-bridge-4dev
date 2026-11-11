// Hosts one independent SlotRunner per configured slot in this process.
import type { RunnerConfig } from "./config.js";
import { errorMessage, type Logger } from "./logger.js";
import { SlotRunner } from "./slotRunner.js";
import { DEFAULT_TIMINGS, type RunnerTimings } from "./timings.js";

export interface StartRunnerOptions {
  /** Run only this worker_id; all slots when omitted. */
  workerId?: string;
  signal: AbortSignal;
  logger: Logger;
  timings?: Partial<RunnerTimings>;
}

export class UnknownWorkerError extends Error {}

/** Resolves once every slot loop has stopped (after `signal` aborts). A slot crash is logged and does not stop the others. */
export async function runSlots(config: RunnerConfig, options: StartRunnerOptions): Promise<void> {
  const slots = options.workerId ? config.slots.filter((s) => s.worker_id === options.workerId) : config.slots;
  if (slots.length === 0) {
    const known = config.slots.map((s) => s.worker_id).join(", ");
    throw new UnknownWorkerError(`no slot with worker_id "${options.workerId}" in config (known: ${known})`);
  }
  const timings: RunnerTimings = { ...DEFAULT_TIMINGS, ...options.timings };
  options.logger.info("runner starting", { bus: config.bus_url, host: config.host, slots: slots.map((s) => s.worker_id).join(",") });

  await Promise.all(
    slots.map(async (slot) => {
      const runner = new SlotRunner({ config, slot, timings, signal: options.signal, logger: options.logger });
      try {
        await runner.run();
      } catch (err) {
        options.logger.error("slot loop crashed", { worker_id: slot.worker_id, error: errorMessage(err) });
      }
    }),
  );
}
