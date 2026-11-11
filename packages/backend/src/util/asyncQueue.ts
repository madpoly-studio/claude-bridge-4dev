// Hàng đợi đẩy-kéo không giới hạn: producer gọi push/end/fail, consumer dùng `for await`.
// Dùng làm prompt streaming (AsyncIterable<SDKUserMessage>) cho Agent SDK và làm luồng message của driver giả.
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: { resolve: (r: IteratorResult<T>) => void; reject: (err: unknown) => void }[] = [];
  private ended = false;
  private failure: { error: unknown } | null = null;

  get closed(): boolean {
    return this.ended || this.failure !== null;
  }

  /** Bỏ qua nếu hàng đợi đã đóng (message gửi sau khi session kết thúc không có nơi nhận). */
  push(item: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
    return true;
  }

  /** Kết thúc bình thường: consumer nhận hết item còn lại rồi `done`. */
  end(): void {
    if (this.closed) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  /** Kết thúc bằng lỗi: consumer nhận hết item còn lại rồi bị throw `error`. */
  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = { error };
    for (const w of this.waiters.splice(0)) w.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.failure) return Promise.reject(this.failure.error);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
