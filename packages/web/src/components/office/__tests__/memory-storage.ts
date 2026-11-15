import { vi } from "vitest";

/** Node 25+ có sẵn một localStorage toàn cục chưa cấu hình (undefined) che mất bản của jsdom: thay bằng bản trong bộ nhớ. */
export function installMemoryStorage(): void {
  if (typeof globalThis.localStorage !== "undefined") return;
  const data = new Map<string, string>();
  const memory: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
  vi.stubGlobal("localStorage", memory);
}
