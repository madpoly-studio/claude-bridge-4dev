// Path containment checks that resist symlinks, `..`, case differences on Windows and prefix tricks
// (`D:/repo-evil` is not inside `D:/repo`).
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const IS_WINDOWS = process.platform === "win32";

/**
 * Absolute, symlink-free form of `p`. A path that does not exist yet is resolved through its nearest existing
 * ancestor, so `<repo>/link-to-outside/missing.txt` still ends up outside the repo.
 */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      // Reached the root without finding anything that exists: keep the lexical form.
      if (parent === current) return abs;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function comparable(p: string): string {
  const trimmed = p.length > 1 && p.endsWith(sep) && !/^[A-Za-z]:\\$/.test(p) ? p.slice(0, -1) : p;
  return IS_WINDOWS ? trimmed.toLowerCase() : trimmed;
}

/** true when `target` is `root` itself or below it. Both should already be canonical (see `canonicalPath`). */
export function isPathInside(root: string, target: string): boolean {
  const r = comparable(root);
  const t = comparable(target);
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}
