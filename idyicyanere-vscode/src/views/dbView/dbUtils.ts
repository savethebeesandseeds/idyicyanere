export function normalizeRel(rel: string): string {
  return (rel ?? "").replace(/\\/g, "/");
}

/**
 * Stored DB chunk format:
 *   FILE: <rel>
 *   CHUNKING: <label>
 *
 *   <text...>
 */
export function parseStoredChunk(raw: string): { rel?: string; chunking?: string; text: string } {
  const s = String(raw ?? "");
  const m = s.match(/^FILE:\s*(.+?)\r?\nCHUNKING:\s*(.+?)\r?\n\r?\n([\s\S]*)$/);
  if (!m) return { text: s };
  return {
    rel: (m[1] ?? "").trim(),
    chunking: (m[2] ?? "").trim(),
    text: m[3] ?? ""
  };
}
