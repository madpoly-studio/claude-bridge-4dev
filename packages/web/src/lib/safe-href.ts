// URL từ dữ liệu server (mr_url do worker LLM báo về, URL Jira...) không đáng tin:
// chỉ cho phép http/https để chặn `javascript:`, `data:`... khi render thành link.

const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/** Trả URL đã chuẩn hóa nếu là http(s) tuyệt đối, ngược lại null. */
export function safeHref(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const trimmed = u.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
