export function normalizeRel(rel: string): string {
  return (rel ?? "").replace(/\\/g, "/").trim();
}

export function makeId(prefix: string): string {
  const r = Math.floor(Math.random() * 1e9).toString(16);
  return `${prefix}_${Date.now().toString(16)}_${r}`;
}

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

export function hasNullByte(bytes: Uint8Array, limit = 2048): boolean {
  const n = Math.min(bytes.length, limit);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export function fmtSegList(nums: number[], limit = 12): string {
  const list = [...nums].sort((a, b) => a - b);
  if (!list.length) return "—";
  if (list.length <= limit) return "#" + list.join(",#");
  const head = list.slice(0, limit);
  const rest = list.length - head.length;
  return "#" + head.join(",#") + ` …(+${rest})`;
}