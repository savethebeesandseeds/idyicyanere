export function normalizeRel(rel: string): string {
  return (rel ?? "").replace(/\\/g, "/");
}

/**
 * Supports the common exclude patterns you already use:
 *   node_modules/**
 *   dist/**
 * etc.
 */
export function deriveExcludedSegments(excludeGlobs: string[]): string[] {
  const out: string[] = [];
  for (const g of excludeGlobs ?? []) {
    const m = g.match(/^\*\*\/([^*?[\]{}!]+)\/\*\*$/);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

export function isExcludedRel(rel: string, excludedSegments: string[]): boolean {
  const parts = normalizeRel(rel).split("/").filter(Boolean);
  for (const seg of excludedSegments) {
    if (parts.includes(seg)) return true;
  }
  return false;
}

export function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v.toFixed(0)} ${u[i]}` : `${v.toFixed(1)} ${u[i]}`;
}