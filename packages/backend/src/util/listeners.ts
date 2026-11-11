// Danh sách listener có kiểu, lỗi của một listener không làm hỏng listener khác.
export type Unsubscribe = () => void;

export class ListenerSet<T> {
  private readonly listeners = new Set<(value: T) => void>();

  constructor(private readonly name: string) {}

  add(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch (err) {
        console.error(`[${this.name}] listener threw:`, err);
      }
    }
  }
}
