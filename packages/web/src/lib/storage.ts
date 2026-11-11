// Web Storage có thể ném lỗi (chế độ riêng tư, bị chặn site data) hoặc không tồn tại (Node),
// nên mọi truy cập đều bọc try/catch.

export type StorageArea = "local" | "session";

function areaOf(area: StorageArea): Storage | undefined {
  // Truy cập thuộc tính cũng có thể ném (SecurityError), nên gọi trong try của nơi dùng.
  return area === "local" ? globalThis.localStorage : globalThis.sessionStorage;
}

export function readStorage(key: string, area: StorageArea = "local"): string | null {
  try {
    return areaOf(area)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null, area: StorageArea = "local"): void {
  try {
    const s = areaOf(area);
    if (value === null) s?.removeItem(key);
    else s?.setItem(key, value);
  } catch {
    // Bỏ qua: chỉ là tiện ích nhớ cấu hình.
  }
}
