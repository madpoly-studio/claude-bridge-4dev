// Ships stream-json events to POST /tasks/{id}/events in order, in batches, with retry.
import { isRetryableBusError } from "./busClient.js";
import { errorMessage, type Logger } from "./logger.js";
import { AbortedError, retry, type BackoffOptions } from "./retry.js";

export interface EventForwarderOptions {
  /** Sends one batch. Must throw on failure. */
  send: (events: unknown[], signal: AbortSignal) => Promise<void>;
  flushIntervalMs: number;
  maxBatch: number;
  /** Pending events kept while the bus is unreachable; beyond this the oldest are dropped (logged). */
  maxBuffered: number;
  backoff: BackoffOptions;
  /** Aborting stops retries; remaining events are dropped with an error log. */
  signal: AbortSignal;
  logger: Logger;
}

/** Marker event inserted where events had to be dropped, so the gap is visible on the bus side. */
export interface EventsDroppedNotice {
  type: "runner_notice";
  subtype: "events_dropped";
  count: number;
}

/**
 * Single sender, FIFO queue: a batch is taken from the head and re-sent until it succeeds, so order
 * is preserved. Nothing is sent until `open()` (the bus expects `started` first).
 */
export class EventForwarder {
  private readonly queue: unknown[] = [];
  private isOpen = false;
  private pumping: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private droppedPending = 0;
  private droppedTotal = 0;
  private sentTotal = 0;

  constructor(private readonly options: EventForwarderOptions) {
    this.timer = setInterval(() => this.kick(), options.flushIntervalMs);
  }

  push(event: unknown): void {
    this.queue.push(event);
    if (this.queue.length > this.options.maxBuffered) {
      const overflow = this.queue.length - this.options.maxBuffered;
      this.queue.splice(0, overflow);
      if (this.droppedPending === 0) {
        this.options.logger.warn("event buffer full, dropping oldest events", { max_buffered: this.options.maxBuffered });
      }
      this.droppedPending += overflow;
      this.droppedTotal += overflow;
    }
    if (this.queue.length >= this.options.maxBatch) {
      this.kick();
    }
  }

  /** Allows sending (call after `started` was posted). */
  open(): void {
    this.isOpen = true;
    this.kick();
  }

  /** Stops the timer and sends everything still queued. Resolves when empty or aborted. */
  async close(): Promise<{ sent: number; dropped: number }> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isOpen = true;
    while (this.pumping || (this.hasPending() && !this.options.signal.aborted)) {
      await (this.pumping ?? this.startPump());
    }
    if (this.hasPending()) {
      const lost = this.queue.length;
      this.droppedTotal += lost;
      this.queue.length = 0;
      this.options.logger.error("events not delivered before shutdown deadline", { dropped: lost });
    }
    return { sent: this.sentTotal, dropped: this.droppedTotal };
  }

  private hasPending(): boolean {
    return this.queue.length > 0 || this.droppedPending > 0;
  }

  private kick(): void {
    if (this.isOpen && !this.pumping && this.hasPending()) {
      void this.startPump();
    }
  }

  private startPump(): Promise<void> {
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async pump(): Promise<void> {
    while (this.hasPending() && !this.options.signal.aborted) {
      const batch = this.takeBatch();
      try {
        await retry(() => this.options.send(batch, this.options.signal), {
          what: "posting events",
          logger: this.options.logger,
          backoff: this.options.backoff,
          signal: this.options.signal,
          isRetryable: isRetryableBusError,
        });
        this.sentTotal += batch.length;
      } catch (err) {
        if (err instanceof AbortedError) {
          // Put the batch back at the head; close() accounts for it as dropped.
          this.queue.unshift(...batch);
          return;
        }
        this.droppedTotal += batch.length;
        this.options.logger.error("bus rejected event batch, dropping it", { count: batch.length, error: errorMessage(err) });
      }
    }
  }

  private takeBatch(): unknown[] {
    const batch: unknown[] = [];
    if (this.droppedPending > 0) {
      const notice: EventsDroppedNotice = { type: "runner_notice", subtype: "events_dropped", count: this.droppedPending };
      batch.push(notice);
      this.droppedPending = 0;
    }
    batch.push(...this.queue.splice(0, this.options.maxBatch - batch.length));
    return batch;
  }
}
