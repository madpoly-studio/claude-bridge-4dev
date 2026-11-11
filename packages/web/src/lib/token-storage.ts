// Nơi lưu pairing token: mặc định sessionStorage (mất khi đóng tab); chỉ khi người dùng chọn
// "Ghi nhớ trên máy này" mới ghi vào localStorage. Token cũ còn trong localStorage vẫn dùng được.
import { STORAGE_KEYS } from "../config";
import { readStorage, writeStorage } from "./storage";

export interface StoredToken {
  token: string | null;
  /** true khi token đang nằm trong localStorage (ghi nhớ lâu dài). */
  remember: boolean;
}

export function loadToken(): StoredToken {
  const session = readStorage(STORAGE_KEYS.token, "session");
  const local = readStorage(STORAGE_KEYS.token, "local");
  return { token: session ?? local, remember: local !== null };
}

/** Ghi token vào đúng một nơi và xóa bản ở nơi còn lại. */
export function saveToken(token: string, remember: boolean): void {
  writeStorage(STORAGE_KEYS.token, token, remember ? "local" : "session");
  writeStorage(STORAGE_KEYS.token, null, remember ? "session" : "local");
}

/** Bỏ ghi nhớ: xóa bản trong localStorage, chuyển token (nếu có) sang sessionStorage của tab này. */
export function forgetRememberedToken(): void {
  const local = readStorage(STORAGE_KEYS.token, "local");
  if (local !== null && readStorage(STORAGE_KEYS.token, "session") === null) writeStorage(STORAGE_KEYS.token, local, "session");
  writeStorage(STORAGE_KEYS.token, null, "local");
}
