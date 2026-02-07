// src/editing/pipeline2/utils.ts

export type ResolvedMode = "plan" | "execute";

export function resolveMode(mode: any, prompt: string): ResolvedMode {
  const m = String(mode ?? "").trim().toLowerCase();
  if (m === "plan") return "plan";
  if (m === "execute") return "execute";

  // default when undefined/empty -> auto behavior
  const p = String(prompt ?? "").toLowerCase();

  const hasDiff =
    p.includes("diff --git") ||
    p.includes("@@") ||
    p.includes("+++ ") ||
    p.includes("--- ") ||
    p.includes("```");

  const execHints = [
    "apply this patch",
    "apply exactly",
    "exactly",
    "do not plan",
    "only change",
    "in file",
    "file:",
    "path:",
    "rename ",
    "replace ",
    "delete ",
    "insert ",
    "move ",
  ];

  if (hasDiff) return "execute";
  if (execHints.some((h) => p.includes(h))) return "execute";
  return "plan";
}

export function normalizeRel(rel: string): string {
  return String(rel ?? "").replace(/\\/g, "/").trim();
}

export function errMsg(e: any): string {
  return (e?.message ?? String(e ?? "error")).trim();
}

export function sevRank(sev: "warn" | "error"): number {
  return sev === "error" ? 2 : 1;
}

export function clampInt(x: any, lo: number, hi: number, def: number): number {
  const n = Math.trunc(Number(x));
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

export async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<void>
): Promise<void> {
  const n = Math.max(1, Math.min(limit, items.length || 1));
  let next = 0;

  const workers = Array.from({ length: n }, () =>
    (async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i], i);
      }
    })()
  );

  await Promise.all(workers);
}

export function tokenizeText(p: string, max = 48): string[] {
  const t = String(p ?? "").toLowerCase();
  const words = t.split(/[^a-z0-9_]+/g).map((x) => x.trim()).filter(Boolean);

  const out: string[] = [];
  for (const w of words) {
    if (w.length < 3) continue;
    if (!out.includes(w)) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

export function promptWantsFormatting(prompt: string): boolean {
  const p = String(prompt ?? "").toLowerCase();
  const hits = [
    "format",
    "formatting",
    "prettier",
    "eslint",
    "lint",
    "style",
    "whitespace",
    "indent",
    "tabs",
    "spaces",
    "line ending",
    "line-ending",
    "line endings",
    "crlf",
    "lf",
    "normalize line endings"
  ];
  return hits.some((k) => p.includes(k));
}

export function stripAllWhitespace(s: string): string {
  return String(s ?? "").replace(/\s+/g, "");
}

export function isWhitespaceOnlyChange(a: string, b: string): boolean {
  if (a === b) return true;
  return stripAllWhitespace(a) === stripAllWhitespace(b);
}

export type LineEnding = "lf" | "crlf";

export function detectDominantLineEnding(text: string): LineEnding {
  const s = String(text ?? "");
  const lfTotal = (s.match(/\n/g) ?? []).length;
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lfOnly = Math.max(0, lfTotal - crlf);
  return crlf >= lfOnly && crlf > 0 ? "crlf" : "lf";
}

export function convertLineEndings(text: string, target: LineEnding): string {
  const norm = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return target === "lf" ? norm : norm.replace(/\n/g, "\r\n");
}

/**
 * FNV-1a 32-bit hash (fast, stable, deterministic).
 */
export function hashFNV1a32(text: string): number {
  const s = String(text ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export function hashHex(text: string, minLen = 8): string {
  const h = hashFNV1a32(text).toString(16);
  return h.padStart(minLen, "0");
}

/**
 * Stable-ish change id: if (rel,start,end,salt) are stable, ids remain stable.
 */
export function makeChangeId(rel: string, start: number, end: number, salt?: string): string {
  const key = `${normalizeRel(rel)}|${start}|${end}|${salt ?? ""}`;
  return `chg_${hashHex(key, 10)}`;
}

/**
 * Newline-snapped segmentation.
 */
export function segmentByChars(
  text: string,
  chunkChars: number,
  opts?: {
    snapToNewline?: boolean;
    newlineWindow?: number;
    preferForward?: boolean;
    minChunkChars?: number;
    maxChunkChars?: number;
  }
): Array<{ start: number; end: number; seg: string; index: number; total: number }> {
  const s = String(text ?? "");
  const minSize = clampInt(opts?.minChunkChars ?? 800, 200, 60000, 800);
  const maxSize = clampInt(opts?.maxChunkChars ?? 12000, 500, 200000, 12000);

  const size = Math.max(minSize, Math.min(maxSize, Math.trunc(chunkChars || 0) || minSize));
  const snap = opts?.snapToNewline ?? true;
  const window = clampInt(opts?.newlineWindow ?? 800, 0, 10000, 800);
  const preferForward = opts?.preferForward ?? true;

  const out: Array<{ start: number; end: number; seg: string; index: number; total: number }> = [];

  let i = 0;
  let idx = 0;

  const minUseful = Math.max(200, Math.floor(size * 0.4));

  while (i < s.length) {
    const start = i;
    let end = Math.min(s.length, i + size);

    if (snap && window > 0 && end < s.length) {
      const forwardLimit = Math.min(s.length, end + window);
      const backLimit = Math.max(start, end - window);

      let forwardNewline = -1;
      for (let j = end; j < forwardLimit; j++) {
        if (s.charCodeAt(j) === 10 /* \n */) {
          forwardNewline = j;
          break;
        }
      }

      let backNewline = -1;
      for (let j = end - 1; j >= backLimit; j--) {
        if (s.charCodeAt(j) === 10 /* \n */) {
          backNewline = j;
          break;
        }
      }

      const canUseBack = backNewline >= 0 && (backNewline + 1 - start) >= minUseful;
      const canUseForward = forwardNewline >= 0;

      if (preferForward && canUseForward) {
        end = forwardNewline + 1;
      } else if (canUseBack) {
        end = backNewline + 1;
      } else if (canUseForward) {
        end = forwardNewline + 1;
      }
    }

    if (end <= start) end = Math.min(s.length, start + 1);

    out.push({ start, end, seg: s.slice(start, end), index: idx, total: 0 });
    i = end;
    idx++;
  }

  if (out.length === 0) out.push({ start: 0, end: 0, seg: "", index: 0, total: 1 });

  const total = out.length;
  for (const x of out) x.total = total;
  return out;
}

/**
 * Convert a region edit into a minimal replacement hunk by stripping common prefix/suffix.
 * (Single contiguous hunk; good enough for this simplified engine.)
 */
export function computeMinimalHunk(params: {
  segStart: number;
  oldSeg: string;
  newSeg: string;
}): { start: number; end: number; oldText: string; newText: string } {
  const { segStart, oldSeg, newSeg } = params;

  if (oldSeg === newSeg) return { start: segStart, end: segStart, oldText: "", newText: "" };

  const a = oldSeg;
  const b = newSeg;

  let prefix = 0;
  const n = Math.min(a.length, b.length);
  while (prefix < n && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;

  let suffix = 0;
  while (
    suffix < (a.length - prefix) &&
    suffix < (b.length - prefix) &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  ) suffix++;

  const oldMid = a.slice(prefix, a.length - suffix);
  const newMid = b.slice(prefix, b.length - suffix);

  const start = segStart + prefix;
  const end = segStart + (a.length - suffix);

  return { start, end, oldText: oldMid, newText: newMid };
}

export function looksLikePromptLeak(s: string): boolean {
  const t = String(s ?? "");
  if (t.includes("<<<") || t.includes(">>>")) return true;
  if (t.includes("USER PROMPT:") || t.includes("UNIT CHANGE:") || t.includes("REPAIR")) return true;
  return false;
}

export function previewHeadTail(text: string, headChars = 2000, tailChars = 800): { head: string; tail: string } {
  const s = String(text ?? "");
  if (!s) return { head: "", tail: "" };
  if (s.length <= headChars + tailChars + 32) return { head: s, tail: "" };
  return { head: s.slice(0, Math.max(0, headChars)), tail: s.slice(Math.max(0, s.length - tailChars)) };
}
