import { log } from "../logging/logger";
import * as fsp from "fs/promises";
import * as path from "path";
import * as fs from "fs";
import type * as vscode from "vscode";

type Metric = "cosine" | "l2";

export type RagHit = {
  rel: string;
  start: number;
  end: number;
  score: number;
  text: string;
  fileHash?: string;
  symbolPath?: string;
  startLine?: number;
  endLine?: number;
};

// ---- Schema (columns) ----
// 1..N are arbitrary, but MUST match how we write/read.
const TEXT_COL = 1;
const VEC_COL = 2;

const REL_COL = 3; // char
const INCLUDED_COL = 4; // bool

const START_COL = 5; // int
const END_COL = 6; // int
const START_LINE_COL = 7; // int
const END_LINE_COL = 8; // int

const FILE_HASH_COL = 9; // char (sha256 hex)
const SYMBOL_PATH_COL = 10; // char (optional)

const IDYDB_CREATE = 7;
const IDYDB_SIM_COSINE = 1;
const IDYDB_SIM_L2 = 2;

type FallbackRow = {
  values: Map<number, any>;
};

type IdyDbRuntime = {
  open: (dbPath: string, flags: number) => void;
  close: () => void;
  columnNextRow: (col: number) => number;
  ragUpsertText: (textCol: number, vecCol: number, row: number, text: string, vec: Float32Array) => void;
  insertConstChar: (col: number, row: number, value: string) => void;
  insertBool: (col: number, row: number, value: boolean) => void;
  insertInt: (col: number, row: number, value: number) => void;
  setRowsIncluded: (includedCol: number, rows: number[], included: boolean) => void;
  deleteCell: (col: number, row: number) => void;
  ragQueryHitsIncludedOnly: (
    textCol: number,
    vecCol: number,
    includedCol: number,
    relCol: number,
    queryVec: Float32Array,
    limit: number,
    metric: number,
    metaCols: number[],
    relFilter: string
  ) => Array<{ row?: number; score: number; text: string; meta?: Record<string, any> }>;
};

type AddonModule = {
  IdyDb: new () => IdyDbRuntime;
  __fallback?: boolean;
  __reason?: string;
};

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let out = 0;
  for (let i = 0; i < n; i++) out += a[i] * b[i];
  return out;
}

function norm2(a: Float32Array): number {
  let out = 0;
  for (let i = 0; i < a.length; i++) out += a[i] * a[i];
  return Math.sqrt(out);
}

function l2(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let out = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    out += d * d;
  }
  return Math.sqrt(out);
}

function createFallbackAddon(reason: string): AddonModule {
  class FallbackIdyDb implements IdyDbRuntime {
    private rows = new Map<number, FallbackRow>();
    private persistPath = "";

    private static encodeValue(v: any): any {
      if (v instanceof Float32Array) return { __f32: Array.from(v) };
      return v;
    }

    private static decodeValue(v: any): any {
      if (v && typeof v === "object" && Array.isArray(v.__f32)) {
        return new Float32Array(v.__f32.map((x: any) => Number(x) || 0));
      }
      return v;
    }

    private loadPersisted(): void {
      if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
      try {
        const raw = fs.readFileSync(this.persistPath, "utf8");
        const parsed = JSON.parse(raw);
        this.rows.clear();
        for (const r of parsed?.rows ?? []) {
          const row = Math.trunc(Number(r?.row));
          if (!Number.isFinite(row) || row <= 0) continue;
          const values = new Map<number, any>();
          const src = r?.values ?? {};
          for (const [k, v] of Object.entries(src)) {
            const col = Math.trunc(Number(k));
            if (!Number.isFinite(col) || col <= 0) continue;
            values.set(col, FallbackIdyDb.decodeValue(v));
          }
          this.rows.set(row, { values });
        }
      } catch (err) {
        log.warn("Fallback IdyDB: failed to load persisted store; starting empty", {
          reason: err instanceof Error ? err.message : String(err)
        });
        this.rows.clear();
      }
    }

    private persist(): void {
      if (!this.persistPath) return;
      try {
        const rows: Array<{ row: number; values: Record<string, any> }> = [];
        for (const [row, rec] of this.rows.entries()) {
          const values: Record<string, any> = {};
          for (const [col, val] of rec.values.entries()) {
            values[String(col)] = FallbackIdyDb.encodeValue(val);
          }
          rows.push({ row, values });
        }
        const json = JSON.stringify({ rows });
        fs.writeFileSync(this.persistPath, json, "utf8");
      } catch (err) {
        log.warn("Fallback IdyDB: failed to persist store", {
          reason: err instanceof Error ? err.message : String(err)
        });
      }
    }

    open(dbPath: string, _flags: number): void {
      this.persistPath = `${dbPath}.fallback.json`;
      this.loadPersisted();
    }

    close(): void {
      this.persist();
    }

    private getRow(row: number): FallbackRow {
      let r = this.rows.get(row);
      if (!r) {
        r = { values: new Map<number, any>() };
        this.rows.set(row, r);
      }
      return r;
    }

    columnNextRow(col: number): number {
      let max = 0;
      for (const [row, rec] of this.rows.entries()) {
        if (rec.values.has(col) && row > max) max = row;
      }
      return max + 1;
    }

    ragUpsertText(textCol: number, vecCol: number, row: number, text: string, vec: Float32Array): void {
      const rec = this.getRow(row);
      rec.values.set(textCol, String(text ?? ""));
      rec.values.set(vecCol, new Float32Array(vec ?? []));
      this.persist();
    }

    insertConstChar(col: number, row: number, value: string): void {
      this.getRow(row).values.set(col, String(value ?? ""));
      this.persist();
    }

    insertBool(col: number, row: number, value: boolean): void {
      this.getRow(row).values.set(col, !!value);
      this.persist();
    }

    insertInt(col: number, row: number, value: number): void {
      this.getRow(row).values.set(col, Math.trunc(Number(value ?? 0)));
      this.persist();
    }

    setRowsIncluded(includedCol: number, rows: number[], included: boolean): void {
      for (const row of rows ?? []) {
        if (!Number.isFinite(Number(row)) || row <= 0) continue;
        this.getRow(Math.trunc(row)).values.set(includedCol, !!included);
      }
      this.persist();
    }

    deleteCell(col: number, row: number): void {
      const rec = this.rows.get(row);
      if (!rec) return;
      rec.values.delete(col);
      if (!rec.values.size) this.rows.delete(row);
      this.persist();
    }

    ragQueryHitsIncludedOnly(
      textCol: number,
      vecCol: number,
      includedCol: number,
      relCol: number,
      queryVec: Float32Array,
      limit: number,
      metric: number,
      metaCols: number[],
      relFilter: string
    ): Array<{ row?: number; score: number; text: string; meta?: Record<string, any> }> {
      const out: Array<{ row?: number; score: number; text: string; meta?: Record<string, any> }> = [];
      const relNeedle = String(relFilter ?? "");
      const q = queryVec instanceof Float32Array ? queryVec : new Float32Array(queryVec ?? []);
      const qNorm = norm2(q);

      for (const [row, rec] of this.rows.entries()) {
        const included = !!rec.values.get(includedCol);
        if (!included) continue;

        const rel = String(rec.values.get(relCol) ?? "");
        if (relNeedle && rel !== relNeedle) continue;

        const text = String(rec.values.get(textCol) ?? "");
        const vecRaw = rec.values.get(vecCol);
        if (!text || !(vecRaw instanceof Float32Array) || !vecRaw.length) continue;

        let score = 0;
        if (metric === IDYDB_SIM_L2) {
          // Keep "higher is better" sort semantics by negating distance.
          score = -l2(q, vecRaw);
        } else {
          const denom = qNorm * norm2(vecRaw);
          score = denom > 0 ? dot(q, vecRaw) / denom : 0;
        }

        const meta: Record<string, any> = {};
        for (const c of metaCols ?? []) {
          if (rec.values.has(c)) meta[String(c)] = rec.values.get(c);
        }

        out.push({ row, score, text, meta });
      }

      out.sort((a, b) => b.score - a.score);
      return out.slice(0, Math.max(1, Math.trunc(Number(limit ?? 1))));
    }
  }

  return {
    IdyDb: FallbackIdyDb,
    __fallback: true,
    __reason: reason
  };
}

export function loadAddon(context: vscode.ExtensionContext) {
  const addonPath = path.join(
    context.extensionPath,
    "native",
    "idydb-addon",
    "build",
    "Release",
    "idydb.node"
  );

  if (!fs.existsSync(addonPath)) {
    const reason = `idydb addon missing at: ${addonPath}`;
    log.warn("Native IdyDB addon unavailable; using JS fallback", { reason });
    return createFallbackAddon(reason);
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(addonPath) as AddonModule;
  } catch (err: any) {
    const reason = err?.message ?? String(err);
    log.warn("Native IdyDB addon failed to load; using JS fallback", { addonPath, reason });
    return createFallbackAddon(reason);
  }
}

type ChunkMeta = {
  start: number;
  end: number;
  startLine?: number;
  endLine?: number;
  symbolPath?: string;
};

export class IdyDbStore {
  private addon: AddonModule;
  private db: IdyDbRuntime;

  // ---- free row pool (in-memory) ----
  private freeRows: number[] = [];
  private freeRowSet = new Set<number>();

  private isOpen = false;

  // Serialize all native calls (open/close/query/write) to avoid lock races.
  private gate: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly dbPath: string) {
      this.addon = loadAddon(context);
      this.db = new this.addon.IdyDb();
      if (this.addon.__fallback) {
        log.warn("IdyDbStore running in JS fallback mode (native addon unavailable)", {
          reason: this.addon.__reason ?? "unknown"
        });
      }
  }

  private async runExclusive<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } catch (e: any) {
      log.caught(`IdyDbStore.runExclusive(${label})`, e);
      throw e;
    } finally {
      release();
    }
  }

  private async safeClose(): Promise<void> {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
    this.isOpen = false;
  }

  private async deleteDbFile(): Promise<void> {
    try {
      await fsp.unlink(this.dbPath);
      log.warn("IdyDbStore: deleted DB file", { dbPath: this.dbPath });
    } catch (e: any) {
      // If it doesn't exist, that's fine.
      if (e?.code !== "ENOENT") log.caught("IdyDbStore.deleteDbFile", e);
    }
    try {
      await fsp.unlink(`${this.dbPath}.fallback.json`);
    } catch (e: any) {
      if (e?.code !== "ENOENT") log.caught("IdyDbStore.deleteDbFile fallback", e);
    }
  }

  /**
   * Schema probe: touch the *highest* column index we rely on.
   * If DB was created with older schema, native should throw / rc=1 here.
   */
  private probeSchema(): void {
    // We rely on SYMBOL_PATH_COL existing.
    // columnNextRow is cheap and forces native to validate column id.
    this.db.columnNextRow(SYMBOL_PATH_COL);
  }

  async open(opts?: { onRecreated?: (reason: string) => Promise<void> }): Promise<void> {
    return this.runExclusive("open", async () => {
      if (this.isOpen) return;
      log.info("IdyDbStore.open()", { dbPath: this.dbPath });

      try {
        this.db.open(this.dbPath, IDYDB_CREATE);
        this.isOpen = true;

        // Probe immediately so we fail fast.
        this.probeSchema();
        return;
      } catch (e: any) {
        const reason = `schema probe/open failed: ${e?.message ?? String(e)}`;
        log.warn("IdyDbStore.open(): will recreate DB", { reason, dbPath: this.dbPath });

        await this.safeClose();
        await this.deleteDbFile();

        // Re-open fresh DB
        this.db.open(this.dbPath, IDYDB_CREATE);
        this.isOpen = true;

        // Reset in-memory row reuse bookkeeping
        this.resetFreePool();

        // Let caller reset manifest.json, etc.
        if (opts?.onRecreated) {
          try {
            await opts.onRecreated(reason);
          } catch (e2: any) {
            log.caught("IdyDbStore.onRecreated", e2);
          }
        }

        // Probe again: if this fails, something deeper is broken (native).
        this.probeSchema();
      }
    });
  }

  /** Clears any in-memory reuse bookkeeping (useful after deleting/recreating the DB). */
  resetFreePool(): void {
    this.freeRows = [];
    this.freeRowSet.clear();
  }

  async close(): Promise<void> {
    return this.runExclusive("close", async () => {
      log.info("IdyDbStore.close()");
      this.db.close();
      this.isOpen = false;
    });
  }

  async getNextRow(): Promise<number> {
    return this.runExclusive("getNextRow", async () => {
      const row = this.db.columnNextRow(TEXT_COL);
      return Number(row);
    });
  }

  takeFreeRow(): number | undefined {
    const r = this.freeRows.pop();
    if (r === undefined) return undefined;
    this.freeRowSet.delete(r);
    return r;
  }

  releaseRows(rows: number[]): void {
    for (const raw of rows ?? []) {
      const r = Math.trunc(Number(raw));
      if (!Number.isFinite(r) || r <= 0) continue;
      if (this.freeRowSet.has(r)) continue;
      this.freeRows.push(r);
      this.freeRowSet.add(r);
    }
  }

  /**
   * Inserts chunks for a given file and writes metadata columns.
   * `meta` is aligned 1:1 with `texts`.
   * `fileHash` is written per-row (same value repeated).
   */
  async insertChunksForFile(
    rel: string,
    texts: string[],
    vectors: Float32Array[],
    included = true,
    meta?: ChunkMeta[],
    fileHash?: string
  ): Promise<number[]> {
    return this.runExclusive("insertChunksForFile", async () => {
      if (texts.length !== vectors.length) {
        log.error("IdyDbStore.insertChunksForFile(): texts/vectors length mismatch", {
          texts: texts.length,
          vectors: vectors.length,
        });
        throw new Error("texts/vectors length mismatch");
      }
      if (meta && meta.length !== texts.length) {
        log.error("IdyDbStore.insertChunksForFile(): meta length mismatch", {
          meta: meta.length,
          texts: texts.length,
        });
        throw new Error("meta/texts length mismatch");
      }

      log.debug("IdyDbStore.insertChunksForFile()", { rel, count: texts.length, included });

      let nextRow = Number(this.db.columnNextRow(TEXT_COL));
      const rows: number[] = [];

      for (let i = 0; i < texts.length; i++) {
        const reused = this.takeFreeRow();
        const row = reused ?? nextRow++;

        this.db.ragUpsertText(TEXT_COL, VEC_COL, row, texts[i], vectors[i]);

        // per-row metadata
        this.db.insertConstChar(REL_COL, row, String(rel ?? ""));
        this.db.insertBool(INCLUDED_COL, row, !!included);

        const m = meta?.[i];
        if (m) {
          this.db.insertInt(START_COL, row, Math.trunc(Number(m.start ?? 0)));
          this.db.insertInt(END_COL, row, Math.trunc(Number(m.end ?? 0)));
          if (m.startLine !== undefined) this.db.insertInt(START_LINE_COL, row, Math.trunc(Number(m.startLine)));
          if (m.endLine !== undefined) this.db.insertInt(END_LINE_COL, row, Math.trunc(Number(m.endLine)));
          if (m.symbolPath) this.db.insertConstChar(SYMBOL_PATH_COL, row, String(m.symbolPath));
        }

        if (fileHash) {
          this.db.insertConstChar(FILE_HASH_COL, row, String(fileHash));
        }

        rows.push(row);
      }

      return rows;
    });
  }

  async setRowsIncluded(rows: number[], included: boolean): Promise<void> {
    return this.runExclusive("setRowsIncluded", async () => {
      const list = (rows ?? [])
        .map((r) => Math.trunc(Number(r)))
        .filter((r) => Number.isFinite(r) && r > 0);
      if (!list.length) return;
      log.debug("IdyDbStore.setRowsIncluded()", { rows: list.length, included });
      this.db.setRowsIncluded(INCLUDED_COL, list, !!included);
    });
  }

  async deleteRows(rows: number[]): Promise<void> {
    return this.runExclusive("deleteRows", async () => {
      log.debug("IdyDbStore.deleteRows()", { count: rows.length });

      const freed: number[] = [];
      const colsToDelete = [
        TEXT_COL,
        VEC_COL,
        REL_COL,
        INCLUDED_COL,
        START_COL,
        END_COL,
        START_LINE_COL,
        END_LINE_COL,
        FILE_HASH_COL,
        SYMBOL_PATH_COL,
      ];

      for (const raw of rows) {
        const r = Math.trunc(Number(raw));
        if (!Number.isFinite(r) || r <= 0) continue;

        for (const c of colsToDelete) {
          this.db.deleteCell(c, r);
        }

        freed.push(r);
      }

      this.releaseRows(freed);
    });
  }

  /**
   * Structured query: returns top-k hits with metadata.
   * opts.rel filters to that file (and still requires INCLUDED == true).
   */
    async queryHits(queryVec: Float32Array, k: number, metric: Metric, opts?: { rel?: string }): Promise<RagHit[]> {
      return this.runExclusive("queryHits", async () => {
        const m = metric === "l2" ? IDYDB_SIM_L2 : IDYDB_SIM_COSINE;

        const fn = (this.db as any)?.ragQueryHitsIncludedOnly;
        if (typeof fn !== "function") {
          throw new Error("Native addon missing ragQueryHitsIncludedOnly(). Rebuild native/idydb-addon.");
        }

        const metaCols = [REL_COL, START_COL, END_COL, START_LINE_COL, END_LINE_COL, FILE_HASH_COL, SYMBOL_PATH_COL];

        log.debug("IdyDbStore.queryHits()", { k, metric, rel: opts?.rel ?? "" });

        const limit = Math.max(1, Math.trunc(Number(k ?? 1)));
        const relFilter = opts?.rel ? String(opts.rel) : "";

        const callOnce = () =>
          fn.call(
            this.db,
            TEXT_COL,
            VEC_COL,
            INCLUDED_COL,
            REL_COL,
            queryVec,
            limit,
            m,
            metaCols,
            relFilter
          ) as Array<{ row?: number; score: number; text: string; meta?: Record<string, any> }>;

        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

        // Retry BUSY with backoff; on first BUSY, force reopen once to clear stuck flock state.
        const maxAttempts = 6;
        let delayMs = 40;

        let raw: Array<{ row?: number; score: number; text: string; meta?: Record<string, any> }> = [];

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            raw = callOnce();
            break;
          } catch (e: any) {
            const msg = e?.message ?? String(e);

            const isBusy =
              msg.includes("rc=3") || msg.toLowerCase().includes("busy") || msg.toLowerCase().includes("locked");

            if (isBusy) {
              log.warn("IdyDbStore.queryHits: BUSY; retrying", { attempt, maxAttempts, delayMs, msg });

              // One forced reopen on first BUSY (releases/reacquires flock)
              if (attempt === 1) {
                try {
                  this.db.close();
                } catch {
                  /* ignore */
                }
                this.db.open(this.dbPath, IDYDB_CREATE);
                this.isOpen = true;
                this.probeSchema();
              }

              if (attempt === maxAttempts) {
                throw new Error(
                  "Vector DB is busy (file locked). Another operation (indexing/query) is using it. " +
                    "Wait a moment and try again. " +
                    `Native: ${msg}`
                );
              }

              await sleep(delayMs);
              delayMs = Math.min(400, Math.floor(delayMs * 1.8));
              continue;
            }

            // idydb.h: IDYDB_CORRUPT == 5
            if (msg.includes("rc=5") || msg.toLowerCase().includes("corrupt")) {
              throw new Error(
                "Vector DB appears corrupted. Delete/recreate the DB and re-index included files. " + `Native: ${msg}`
              );
            }

            const lower = msg.toLowerCase();
            const isOom = lower.includes("oom") || lower.includes("out of memory");
            if (isOom) {
              throw new Error(
                "Vector DB query ran out of memory. Try smaller k, fewer meta columns, or restart VS Code. " +
                  `Native: ${msg}`
              );
            }

            // likely schema drift / incompatible DB layout
            throw new Error(
              "Vector DB query failed. If this started after a schema/code change, delete/recreate the DB and re-index. " +
                `Native: ${msg}`
            );
          }
        }

        const hits: RagHit[] = [];

        for (const r of raw ?? []) {
          const meta = (r as any)?.meta ?? {};
          const rel = String(meta[String(REL_COL)] ?? "");

          const start = Number(meta[String(START_COL)] ?? 0);
          const end = Number(meta[String(END_COL)] ?? 0);

          const startLine = meta[String(START_LINE_COL)] == null ? undefined : Number(meta[String(START_LINE_COL)]);
          const endLine = meta[String(END_LINE_COL)] == null ? undefined : Number(meta[String(END_LINE_COL)]);

          const fileHash = meta[String(FILE_HASH_COL)] == null ? undefined : String(meta[String(FILE_HASH_COL)]);
          const symbolPath = meta[String(SYMBOL_PATH_COL)] == null ? undefined : String(meta[String(SYMBOL_PATH_COL)]);

          hits.push({
            rel,
            start: Number.isFinite(start) ? start : 0,
            end: Number.isFinite(end) ? end : 0,
            score: Number((r as any)?.score ?? 0),
            text: String((r as any)?.text ?? ""),
            fileHash: fileHash || undefined,
            symbolPath: symbolPath || undefined,
            startLine: Number.isFinite(startLine as any) ? startLine : undefined,
            endLine: Number.isFinite(endLine as any) ? endLine : undefined,
          });
        }

        return hits;
      });
    }

  /**
   * Backward-ish interface: returns a single string context, but now composed from structured hits.
   * (This keeps context readable without polluting embeddings with FILE: headers.)
   */
  async queryContext(queryVec: Float32Array, k: number, metric: Metric, maxChars: number): Promise<string> {
    const limit = Math.max(1, Math.trunc(Number(k ?? 1)));
    const max = Math.max(1, Math.trunc(Number(maxChars ?? 4000)));

    // queryHits already gates + talks to native
    const hits = await this.queryHits(queryVec, limit, metric);

    let out = "";
    for (const h of hits) {
      const lines =
        h.startLine !== undefined || h.endLine !== undefined
          ? ` (lines ${h.startLine ?? "?"}-${h.endLine ?? "?"})`
          : "";

      const header =
        `FILE: ${h.rel}\n` +
        `RANGE: ${h.start}-${h.end}${lines}\n` +
        `SCORE: ${h.score}\n\n`;

      const block = header + (h.text ?? "") + "\n\n---\n\n";

      if (out.length + block.length > max) {
        if (out.length === 0) out = block.slice(0, max);
        break;
      }
      out += block;
    }

    return out;
  }

  /**
   * Per-file context helper.
   */
  async queryContextForRel(
    queryVec: Float32Array,
    k: number,
    metric: Metric,
    maxChars: number,
    rel: string
  ): Promise<string> {
    const limit = Math.max(1, Math.trunc(Number(k ?? 1)));
    const max = Math.max(1, Math.trunc(Number(maxChars ?? 4000)));

    const hits = await this.queryHits(queryVec, limit, metric, { rel });

    let out = "";
    for (const h of hits) {
      const lines =
        h.startLine !== undefined || h.endLine !== undefined
          ? ` (lines ${h.startLine ?? "?"}-${h.endLine ?? "?"})`
          : "";

      const header =
        `FILE: ${h.rel}\n` +
        `RANGE: ${h.start}-${h.end}${lines}\n` +
        `SCORE: ${h.score}\n\n`;

      const block = header + (h.text ?? "") + "\n\n---\n\n";

      if (out.length + block.length > max) {
        if (out.length === 0) out = block.slice(0, max);
        break;
      }
      out += block;
    }

    return out;
  }
}
