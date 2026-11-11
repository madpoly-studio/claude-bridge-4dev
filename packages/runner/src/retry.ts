// Exponential backoff, abortable sleep and a retry loop for bus calls.
import { errorMessage, type Logger } from "./logger.js";

export interface BackoffOptions {
  baseMs: number;
  capMs: number;
}

export class Backoff {
  private attempt = 0;

  constructor(private readonly options: BackoffOptions) {}

  /** Delay for the next attempt: base * 2^n, capped, with ±20% jitter so slots do not retry in lockstep. */
  nextDelayMs(): number {
    const raw = Math.min(this.options.capMs, this.options.baseMs * 2 ** this.attempt);
    this.attempt += 1;
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.min(this.options.capMs, Math.round(raw * jitter));
  }

  reset(): void {
    this.attempt = 0;
  }
}

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

/** Resolves after `ms`, or rejects with AbortedError as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A signal that aborts `graceMs` after `parent` aborts. Used to bound final flushes during shutdown.
 * Call `dispose()` when done so the listener on the long-lived parent does not accumulate.
 */
export function graceSignal(parent: AbortSignal, graceMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const arm = (): void => {
    setTimeout(() => controller.abort(), graceMs).unref();
  };
  if (parent.aborted) {
    arm();
  } else {
    parent.addEventListener("abort", arm, { once: true });
  }
  return { signal: controller.signal, dispose: () => parent.removeEventListener("abort", arm) };
}

export interface RetryOptions {
  what: string;
  logger: Logger;
  backoff: BackoffOptions;
  /** Stops retrying (rejects with AbortedError) when aborted. */
  signal: AbortSignal;
  /** false = permanent failure, rethrown immediately. */
  isRetryable: (err: unknown) => boolean;
}

/** Runs `fn` until it succeeds, a non-retryable error is thrown, or `signal` aborts. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const backoff = new Backoff(options.backoff);
  for (let attempt = 1; ; attempt++) {
    if (options.signal.aborted) {
      throw new AbortedError();
    }
    try {
      return await fn();
    } catch (err) {
      if (options.signal.aborted) {
        throw new AbortedError();
      }
      if (!options.isRetryable(err)) {
        throw err;
      }
      const delay = backoff.nextDelayMs();
      options.logger.warn(`${options.what} failed, retrying`, { attempt, retry_in_ms: delay, error: errorMessage(err) });
      await sleep(delay, options.signal);
    }
  }
}
