// Long-poll: runner chờ trên GET /runners/{id}/next; assign_task đánh thức ngay (mục 7.5).
export class TaskWaiters {
  private readonly waiters = new Map<string, Set<() => void>>();

  /** Chờ tối đa `ms` hoặc tới khi `notify(workerId)` / `signal` abort. Không bao giờ reject. */
  wait(workerId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted || ms <= 0) {
        resolve();
        return;
      }
      let set = this.waiters.get(workerId);
      if (!set) {
        set = new Set();
        this.waiters.set(workerId, set);
      }
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        const current = this.waiters.get(workerId);
        current?.delete(done);
        if (current && current.size === 0) this.waiters.delete(workerId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      set.add(done);
    });
  }

  notify(workerId: string): void {
    const set = this.waiters.get(workerId);
    if (!set) return;
    for (const done of [...set]) done();
  }

  /** Giải phóng mọi long-poll (khi tắt server). */
  releaseAll(): void {
    for (const set of [...this.waiters.values()]) for (const done of [...set]) done();
  }

  count(workerId: string): number {
    return this.waiters.get(workerId)?.size ?? 0;
  }
}
