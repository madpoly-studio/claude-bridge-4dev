import { randomBytes } from "node:crypto";

/** Token ngẫu nhiên an toàn URL (base64url), mặc định 32 byte. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** ID ngắn có tiền tố, ví dụ `t-3f9a2c1b0d4e`. */
export function shortId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}
