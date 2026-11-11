// localStorage có thể ném lỗi (chế độ riêng tư, bị chặn site data) nên mọi truy cập đều bọc try/catch.

export function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Bỏ qua: chỉ là tiện ích nhớ cấu hình.
  }
}
