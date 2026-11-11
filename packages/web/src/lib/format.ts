const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const THOUSAND = 1_000;
const MILLION = 1_000_000;

function parseTime(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "HH:MM:SS" theo giờ máy. */
export function formatClock(iso: string | null | undefined): string {
  const d = parseTime(iso);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : "--:--:--";
}

/** "HH:MM" theo giờ máy. */
export function formatHourMinute(iso: string | null | undefined): string {
  const d = parseTime(iso);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "--:--";
}

/** Thời lượng ngắn gọn: "<1 phút", "12 phút", "1 giờ 5 phút". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE_MS) return "<1 phút";
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  if (hours === 0) return `${minutes} phút`;
  return minutes === 0 ? `${hours} giờ` : `${hours} giờ ${minutes} phút`;
}

export function elapsedSince(iso: string | null | undefined, now: number): number | null {
  const d = parseTime(iso);
  return d ? Math.max(0, now - d.getTime()) : null;
}

export function durationBetween(fromIso: string | null | undefined, toIso: string | null | undefined, now: number): number | null {
  const from = parseTime(fromIso);
  if (!from) return null;
  const to = parseTime(toIso);
  return Math.max(0, (to ? to.getTime() : now) - from.getTime());
}

/** 48213 → "48k", 1_250_000 → "1.3M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= MILLION) return `${(n / MILLION).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= THOUSAND) return `${Math.round(n / THOUSAND)}k`;
  return String(Math.round(n));
}

export function basename(path: string | null | undefined): string {
  if (!path) return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** ".../merge_requests/412" → "MR !412"; không nhận ra thì "MR". */
export function mrLabel(url: string | null | undefined): string {
  if (!url) return "MR";
  const m = /merge_requests\/(\d+)/.exec(url) ?? /pull\/(\d+)/.exec(url);
  return m ? `MR !${m[1]}` : "MR";
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** JSON gọn một dòng, không bao giờ ném lỗi. */
export function compactJson(value: unknown, max = 160): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  return truncate(s, max);
}
