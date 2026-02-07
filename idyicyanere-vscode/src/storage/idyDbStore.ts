import { log } from "../logging/logger";
import * as fsp from "fs/promises";
import * as fs from "fs";
import * as path from "path";

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

function loadAddon() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../../native/idydb-addon/build/Release/idydb.node");
}

type ChunkMeta = {
  start: number;
  end: number;
  startLine?: number;
  endLine?: number;
  symbolPath?: string;
};

export class IdyDbStore {
  private addon: any;
  private db: any;

  // ---- free row pool (in-memory) ----
  private freeRows: number[] = [];
  private freeRowSet = new Set<number>();

  private isOpen = false;

  // Serialize all native calls (open/close/query/write) to avoid lock races.
  private gate: Promise<void> = Promise.resolve();

  constructor(private readonly dbPath: string) {
    this.addon = loadAddon();
    this.db = new this.addon.IdyDb();
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
