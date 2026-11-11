// Timer tiêm được (debounce wake, tick, poll Jira, backoff orchestrator) để test không phải chờ thật.
/** Opaque: chỉ truyền lại cho clear* của cùng implementation. */
export type TimerHandle = unknown;

export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/** Timer thật của Node; `unref` để timer nền không giữ process sống khi shutdown. */
export const systemTimers: Timers = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
  setInterval(fn, ms) {
    const t = setInterval(fn, ms);
    t.unref();
    return t;
  },
  clearInterval(handle) {
    clearInterval(handle as NodeJS.Timeout);
  },
};
