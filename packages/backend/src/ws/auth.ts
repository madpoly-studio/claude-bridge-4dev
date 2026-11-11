// Auth Gate (mục 5.1, 12): Origin allowlist + token ở message đầu tiên.
import { safeEqual } from "../bus/tokens.js";

export interface AuthPrincipal {
  /** Định danh người dùng; pairing token chỉ có một người dùng. */
  subject: string;
}

/** Điểm mở rộng: v1 dùng pairing token; JWT của SSO (JWKS) thêm sau bằng một implementation khác. */
export interface TokenVerifier {
  verify(token: string): Promise<AuthPrincipal | null>;
}

export class PairingTokenVerifier implements TokenVerifier {
  constructor(private readonly pairingToken: string) {}

  async verify(token: string): Promise<AuthPrincipal | null> {
    return safeEqual(token, this.pairingToken) ? { subject: "local-user" } : null;
  }
}

/** So khớp chính xác (scheme + host + port). Thiếu Origin cũng bị từ chối. */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false;
  return allowed.includes(origin);
}
