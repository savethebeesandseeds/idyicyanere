import * as vscode from "vscode";

/** Stats emitted by both dump modes. */
export type DumpStats = {
  selectedFromManifest: number;
  selectedFromUserPaths: number;
  includedWritten: number;
  skippedMissing: number;
  skippedBinary: number;
  skippedHidden: number;
  truncatedFiles: number;
  stoppedByMaxTotal: boolean;
  totalBytesWritten: number; // content bytes (not counting headers)
  outputFsPath: string;
};

export type dumpContextIndexedResult = {
  outputUri: vscode.Uri;
  backupsDir: vscode.Uri;
  stats: DumpStats;
  cancelled: boolean;
};

export type DumpTreeNode = {
  uri: string;          // vscode.Uri.toString()
  name: string;         // basename
  rel: string;          // workspace-relative (or root name prefix in multi-root)
  kind: "dir" | "file";
  hidden: boolean;
  excluded: boolean;    // true if filtered by excludedSegments
};

export type DumpWriteOptions = {
  includeHidden: boolean;
  noFences: boolean;
  listOnly: boolean;
  maxFileBytes: number; // 0 = unlimited
  maxTotalBytes: number; // 0 = unlimited
};

export type DumpWriterItem = {
  uri: vscode.Uri;
  rel: string;
  hidden: boolean;
  // flags show up in headers; the writer doesn’t compute them
  stale?: boolean;
  indexed?: boolean;
};

export function normalizeRel(rel: string): string {
  return (rel ?? "").replace(/\\/g, "/");
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function tsUtcForFilename(d = new Date()): string {
  // YYYYMMDD_HHMMSS (UTC)
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `_${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
  );
}

export function utcNowString(): string {
  // "YYYY-MM-DD HH:MM:SS UTC"
  const d = new Date();
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`
  );
}

function lowerExt(p: string): string {
  const m = p.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

export function langForRel(rel: string): string {
  const ext = lowerExt(rel);
  switch (ext) {
    case "c":
    case "h": return "c";
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hh":
    case "hxx": return "cpp";
    case "rs": return "rust";
    case "py": return "python";
    case "js":
    case "mjs":
    case "cjs": return "javascript";
    case "ts": return "typescript";
    case "tsx": return "tsx";
    case "jsx": return "jsx";
    case "go": return "go";
    case "java": return "java";
    case "cs": return "csharp";
    case "rb": return "ruby";
    case "php": return "php";
    case "sh":
    case "bash":
    case "zsh": return "bash";
    case "toml": return "toml";
    case "yaml":
    case "yml": return "yaml";
    case "json": return "json";
    case "html":
    case "htm": return "html";
    case "css":
    case "scss": return "css";
    case "sql": return "sql";
    case "xml": return "xml";
    case "md": return "markdown";
    default: return "";
  }
}

export function sanitizeSimpleName(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return fallback;
  // Keep it simple: no path traversal, no separators.
  if (s.includes("/") || s.includes("\\") || s.includes("..")) return fallback;
  return s;
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}

export function isAbsoluteFsPath(p: string): boolean {
  const s = (p ?? "").trim();
  if (!s) return false;
  if (s.startsWith("/") || s.startsWith("\\")) return true;
  // Windows drive: C:\ or C:/
  return /^[a-zA-Z]:[\\/]/.test(s);
}

export function isProbablyHiddenRel(rel: string): boolean {
  const parts = (rel ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  for (const seg of parts) {
    if (seg.startsWith(".") && seg !== "." && seg !== "..") return true;
  }
  return false;
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
  const parts = (rel ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  for (const seg of excludedSegments) {
    if (parts.includes(seg)) return true;
  }
  return false;
}

export async function openInEditor(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
}

/** Small path helpers (avoid importing `path` just for basename/ext) */
export function pathExt(fsPath: string): string {
  const i = fsPath.lastIndexOf(".");
  const j = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  if (i <= j) return "";
  return fsPath.slice(i);
}

export function pathBaseNoExt(fsPath: string): string {
  const base = fsPath.split(/[\\/]/).pop() || "dump";
  const i = base.lastIndexOf(".");
  if (i <= 0) return base;
  return base.slice(0, i);
}