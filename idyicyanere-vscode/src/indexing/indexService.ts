import * as vscode from "vscode";
import { ManifestService } from "../storage/manifestService";
import { ConfigService } from "../storage/configService";
import { OpenAIService } from "../openai/openaiService";
import { IdyDbStore } from "../storage/idyDbStore";
import { log } from "../logging/logger";
import * as path from "path";
import * as crypto from "crypto";

//  Imports for the chunking refactor
import { ChunkingStrategy } from "./chunking/types";
import { FixedChunker } from "./chunking/fixedChunker";
import { LineChunker } from "./chunking/lineChunker";

export type FileIndexStatus =
  | { kind: "not_indexed"; label: "not indexed"; icon: vscode.ThemeIcon }
  | { kind: "indexed"; label: "indexed"; icon: vscode.ThemeIcon }
  | { kind: "stale"; label: "stale"; icon: vscode.ThemeIcon }
  | { kind: "indexing"; label: "indexing…"; icon: vscode.ThemeIcon }
  | { kind: "hidden"; label: "hidden"; icon: vscode.ThemeIcon }
  | { kind: "error"; label: "error"; icon: vscode.ThemeIcon };

function isRecord(x: any): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function normalizeRelPath(rel: string): string {
  return (rel ?? "").replace(/\\/g, "/");
}

function getVscodeExcludeKeys(section: "files" | "search"): string[] {
  const cfg = vscode.workspace.getConfiguration(section);
  const obj = cfg.get<any>("exclude");
  if (!isRecord(obj)) return [];
  return Object.entries(obj)
    .filter(([, v]) => v === true)
    .map(([k]) => String(k).trim())
    .filter(Boolean);
}

function normalizeExcludeGlob(g: string): string {
  const s = String(g ?? "").trim();
  if (!s) return "";
  // If user wrote a bare segment like "node_modules", treat it as folder
  if (!/[*?\[\]{}/]/.test(s) && !s.includes("**")) {
    const seg = s.replace(/\/+$/g, "");
    return `**/${seg}/**`;
  }
  if (s.endsWith("/")) return `${s}**`;
  return s;
}

/**
 * Same fast-path logic used in FilesView: extract folder "segments" from globs like "node_modules/**".
 * This keeps indexing decisions cheap + stable.
 */
function deriveExcludedSegments(excludeGlobs: string[]): string[] {
  const out: string[] = [];
  for (const g of excludeGlobs ?? []) {
    const m = String(g).match(/^\*\*\/([^*?[\]{}!]+)\/\*\*$/);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

function isExcludedRel(rel: string, excludedSegments: string[]): boolean {
  const parts = normalizeRelPath(rel).split("/").filter(Boolean);
  for (const seg of excludedSegments) {
    if (parts.includes(seg)) return true;
  }
  return false;
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

export class IndexService {
  private indexing = new Set<string>();

  //  Strategy instances
  private fixedChunker = new FixedChunker();
  private lineChunker = new LineChunker();

  getIndexingCount(): number {
    return this.indexing.size;
  }

  constructor(
    private readonly config: ConfigService,
    private readonly manifest: ManifestService,
    private readonly store: IdyDbStore,
    private readonly openai: OpenAIService
  ) {}

  private normalizeExt(ext: string): string {
    if (!ext) return "";
    const e = ext.startsWith(".") ? ext : `.${ext}`;
    return e.toLowerCase();
  }

  private getIndexExcludeGlobs(): string[] {
    const own = (this.config.data.indexing.excludeGlobs ?? []).map(normalizeExcludeGlob).filter(Boolean);
    const vs = [
      ...getVscodeExcludeKeys("files"),
      ...getVscodeExcludeKeys("search"),
    ].map(normalizeExcludeGlob).filter(Boolean);

    return uniq([...own, ...vs]);
  }

  private isExcludedByConfig(rel: string): boolean {
    const globs = this.getIndexExcludeGlobs();
    const segs = deriveExcludedSegments(globs);
    return isExcludedRel(rel, segs);
  }

  //  Helper to resolve strategy + size from config
  private getChunkerForRel(rel: string): { strategy: ChunkingStrategy; chunkChars: number } {
    const ext = this.normalizeExt(path.extname(rel));
    const byExt = this.config.data.indexing.chunking.byExtension;

    // Default config object
    const rule = (ext && byExt[ext]) ? byExt[ext] : this.config.data.indexing.chunking.default;

    // Heuristic: Use LineChunker (smart) for everything by default as it is safer for code.
    // If you needed specific files to be fixed-width (e.g. .txt logs), you could add logic here.
    return { 
      strategy: this.lineChunker, 
      chunkChars: rule.chunkChars 
    };
  }

  getIndexedChunking(uri: vscode.Uri): { method: string; chunkChars: number } | undefined {
    return this.manifest.get(uri.toString())?.chunking;
  }

  async getStatus(uri: vscode.Uri, stat?: vscode.FileStat): Promise<FileIndexStatus> {
    const key = uri.toString();

    if (this.indexing.has(key)) {
      return { kind: "indexing", label: "indexing…", icon: new vscode.ThemeIcon("sync~spin") };
    }

    const entry = this.manifest.get(key);
    if (!entry) {
      return { kind: "not_indexed", label: "not indexed", icon: new vscode.ThemeIcon("circle-outline") };
    }

    if (entry.included === false) {
      return { kind: "hidden", label: "hidden", icon: new vscode.ThemeIcon("eye-closed") };
    }

    try {
      const s = stat ?? (await vscode.workspace.fs.stat(uri));
      if (s.mtime !== entry.mtimeMs) {
        return { kind: "stale", label: "stale", icon: new vscode.ThemeIcon("warning") };
      }

      return { kind: "indexed", label: "indexed", icon: new vscode.ThemeIcon("check") };
    } catch (err) {
      log.caught("IndexService.getStatus", err);
      return { kind: "error", label: "error", icon: new vscode.ThemeIcon("error") };
    }
  }

  async indexFile(uri: vscode.Uri): Promise<void> {
    await this.store.open(); // safe + gated
    const key = uri.toString();
    if (this.indexing.has(key)) return;

    const t0 = Date.now();
    this.indexing.add(key);

    const rel = vscode.workspace.asRelativePath(uri, false);

    // Skip ignored paths (config indexing.excludeGlobs + VS Code excludes)
    if (this.isExcludedByConfig(rel)) {
      log.info("IndexService.indexFile() skipped (excluded)", { file: rel });
      vscode.window.showInformationMessage(`Skipped (excluded): ${rel}`);
      return;
    }

    const { strategy, chunkChars } = this.getChunkerForRel(rel);

    log.info("IndexService.indexFile() start", { file: rel, strategy: strategy.constructor.name });

    try {
      const stat = await vscode.workspace.fs.stat(uri);

      const bytes = await vscode.workspace.fs.readFile(uri);
      const maxFileBytes = this.config.data.indexing.maxFileBytes;

      if (bytes.byteLength === 0) {
        const old = this.manifest.get(key);
        if (old?.rows?.length) {
          log.info("Empty file -> deleting old rows", { file: rel, rows: old.rows.length });
          await this.store.deleteRows(old.rows);
        }
        if (old) {
          this.manifest.delete(key);
          await this.manifest.save();
        }
        log.warn("Skipped (empty)", { file: rel });
        vscode.window.showWarningMessage(`Skipped (empty): ${uri.fsPath}`);
        return;
      }

      if (bytes.byteLength > maxFileBytes) {
        log.warn("Skipped (too large)", { file: rel, bytes: bytes.byteLength, max: maxFileBytes });
        vscode.window.showWarningMessage(`Skipped (too large): ${uri.fsPath}`);
        return;
      }

      for (let i = 0; i < Math.min(bytes.length, 2048); i++) {
        if (bytes[i] === 0) {
          log.warn("Skipped (binary)", { file: rel });
          vscode.window.showWarningMessage(`Skipped (binary): ${uri.fsPath}`);
          return;
        }
      }

      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

      if (text.trim().length === 0) {
        const old = this.manifest.get(key);
        if (old?.rows?.length) {
          log.info("Whitespace-only file -> deleting old rows", { file: rel, rows: old.rows.length });
          await this.store.deleteRows(old.rows);
        }
        if (old) {
          this.manifest.delete(key);
          await this.manifest.save();
        }
        log.warn("Skipped (whitespace-only)", { file: rel });
        vscode.window.showWarningMessage(`Skipped (empty/whitespace): ${uri.fsPath}`);
        return;
      }

      const old = this.manifest.get(key);
      if (old?.rows?.length) {
        log.debug("Removing old rows", { file: rel, rows: old.rows.length });
        await this.store.deleteRows(old.rows);
      }

      //  Use the strategy to chunk
      const pieces = strategy.chunk(text, chunkChars);

      if (pieces.length === 0) {
        log.warn("Skipped (no chunks produced)", { file: rel });
        vscode.window.showWarningMessage(`Skipped (no chunks): ${uri.fsPath}`);
        return;
      }

      const chunks = pieces.map((p) => p.text);

      log.debug("Chunked file", { file: rel, method: strategy.constructor.name, chunks: chunks.length });

      // sha256 hash of original bytes (stable, cheap)
      const fileHash = crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");

      const embeddings = await this.openai.embedTexts(chunks);

      const metas = pieces.map((p) => ({
        start: p.start,
        end: p.end,
        startLine: p.startLine,
        endLine: p.endLine
      }));

      const rows = await this.store.insertChunksForFile(rel, chunks, embeddings, true, metas, fileHash);

      // Save chunking info to manifest so we know how it was processed
      const chunkingInfo = { method: strategy.constructor.name, chunkChars };
      
      this.manifest.set(key, { mtimeMs: stat.mtime, rows, chunking: chunkingInfo });
      await this.manifest.save();

      log.info("IndexService.indexFile() complete", {
        file: rel,
        chunks: chunks.length,
        rows: rows.length,
        ms: Date.now() - t0
      });
    } catch (err) {
      log.caught("IndexService.indexFile", err);
      vscode.window.showErrorMessage(`Index failed: ${uri.fsPath}`);
    } finally {
      this.indexing.delete(key);
    }
  }

  async reindexStaleIncluded(
    opts?: {
      limit?: number;
      onProgress?: (msg: string) => void;
    }
  ): Promise<{
    found: number;
    reindexed: number;
    failed: number;
    missing: number;
    skippedIndexing: number;
  }> {
    await this.store.open(); // safe + gated
    const limit = Math.max(1, Math.min(1000, opts?.limit ?? 50));
    const onProgress = opts?.onProgress;

    const staleUris: vscode.Uri[] = [];

    for (const [key, entry] of this.manifest.entries()) {
      if (staleUris.length >= limit) break;

      if (entry.included === false) continue;

      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(key);
      } catch {
        continue;
      }

      const k = uri.toString();
      if (this.indexing.has(k)) continue;

      try {
        const st = await vscode.workspace.fs.stat(uri);
        if (st.mtime !== entry.mtimeMs) {
          staleUris.push(uri);
        }
      } catch {
        // missing on disk
      }
    }

    const result = {
      found: staleUris.length,
      reindexed: 0,
      failed: 0,
      missing: 0,
      skippedIndexing: 0
    };

    if (!staleUris.length) return result;

    for (let i = 0; i < staleUris.length; i++) {
      const uri = staleUris[i];
      const rel = vscode.workspace.asRelativePath(uri, false);
      const k = uri.toString();

      if (this.indexing.has(k)) {
        result.skippedIndexing++;
        continue;
      }

      try {
        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          result.missing++;
          continue;
        }

        onProgress?.(`Refreshing stale files… ${i + 1}/${staleUris.length}: ${rel}`);
        await this.indexFile(uri);
        result.reindexed++;
      } catch (err) {
        log.caught("IndexService.reindexStaleIncluded", err);
        result.failed++;
      }
    }

    return result;
  }

  async setHidden(uri: vscode.Uri, hidden: boolean): Promise<void> {
    const key = uri.toString();
    const rel = vscode.workspace.asRelativePath(uri, false);

    log.info("IndexService.setHidden() start", { file: rel, hidden });

    try {
      const entry = this.manifest.get(key);
      if (!entry) return;

      if (hidden) entry.included = false;
      else delete (entry as any).included;

      this.manifest.set(key, entry);
      await this.manifest.save();
      await this.store.setRowsIncluded(entry.rows ?? [], !hidden);

      log.info("IndexService.setHidden() complete", { file: rel, hidden });
    } catch (err) {
      log.caught("IndexService.setHidden", err);
      vscode.window.showErrorMessage(`Hide/unhide failed: ${uri.fsPath}`);
    }
  }

  async removeFile(uri: vscode.Uri): Promise<void> {
    await this.setHidden(uri, true);
  }

  async purgeFile(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const rel = vscode.workspace.asRelativePath(uri, false);

    const entry = this.manifest.get(key);
    if (!entry) return;

    log.info("IndexService.purgeFile() start", { file: rel, rows: entry.rows?.length ?? 0 });

    try {
      entry.included = false;
      this.manifest.set(key, entry);
      await this.manifest.save();

      await this.store.setRowsIncluded(entry.rows ?? [], false);

      if (entry.rows?.length) {
        await this.store.deleteRows(entry.rows);
      }

      this.manifest.delete(key);
      await this.manifest.save();

      log.info("IndexService.purgeFile() complete", { file: rel });
    } catch (err) {
      log.caught("IndexService.purgeFile", err);
      vscode.window.showErrorMessage(`Purge failed: ${uri.fsPath}`);
    }
  }
}