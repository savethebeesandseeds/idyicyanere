import * as vscode from "vscode";
import { StoragePaths } from "../../storage/paths";
import { ManifestService } from "../../storage/manifestService";
import { ConfigService, RagMetric } from "../../storage/configService";
import { OpenAIService } from "../../openai/openaiService";
import { IdyDbStore } from "../../storage/idyDbStore";
import { IndexService } from "../../indexing/indexService";
import { log } from "../../logging/logger";

import { WebviewIn, WebviewOut, DbFileRow, QueryHit, QueryResultPayload } from "./dbContract";
import { normalizeRel, parseStoredChunk } from "./dbUtils";

export type DbDeps = {
  paths: StoragePaths;
  manifest: ManifestService;
  indexer: IndexService;
  store: IdyDbStore;
  config: ConfigService;
  openai: OpenAIService;
  onIndexMutated?: (uri?: vscode.Uri) => void;
};

export type DbHost = {
  post(payload: WebviewOut): void;
  status(text: string): void;
  error(text: string): void;
  withProgress(title: string, uri: vscode.Uri, fn: () => Promise<void>): Promise<void>;
};

function clampInt(x: any, def: number, lo: number, hi: number): number {
  const n = Math.trunc(Number(x));
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

function coerceMetric(metric: any, fallback: RagMetric): RagMetric {
  return metric === "l2" || metric === "cosine" ? metric : fallback;
}

function buildRelToUriMap(manifest: ManifestService): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key] of manifest.entries()) {
    try {
      const uri = vscode.Uri.parse(key);
      const rel = normalizeRel(vscode.workspace.asRelativePath(uri, false));
      if (rel) map.set(rel, uri.toString());
    } catch {
      // ignore
    }
  }
  return map;
}

async function ensureFreshIncludedIndex(host: DbHost, deps: DbDeps, limit: number): Promise<void> {
  host.status("Checking for stale indexed files…");
  const refresh = await deps.indexer.reindexStaleIncluded({
    limit,
    onProgress: (s) => host.status(s),
  });
  if (refresh.found > 0) log.info("DB: refreshed stale files", refresh);
}

export async function sendStats(host: DbHost, deps: DbDeps): Promise<void> {
  await deps.config.ensure();

  const dbPath = deps.paths.dbPath;

  let dbExists = true;
  let dbSizeBytes: number | null = null;
  let dbMtimeMs: number | null = null;

  try {
    const st = await vscode.workspace.fs.stat(deps.paths.dbUri);
    dbSizeBytes = st.size;
    dbMtimeMs = st.mtime;
  } catch {
    dbExists = false;
  }

  let nextRow: number | null = null;
  try {
    nextRow = await deps.store.getNextRow();
  } catch {
    nextRow = null;
  }

  const files: DbFileRow[] = [];

  const uniqueAll = new Set<number>();
  const uniqueIncluded = new Set<number>();

  let totalFiles = 0;
  let hiddenFiles = 0;
  let includedFiles = 0;

  let trackedRowsAll = 0;
  let trackedRowsIncluded = 0;

  for (const [key, entry] of deps.manifest.entries()) {
    totalFiles++;

    const isHidden = entry.included === false;
    if (isHidden) hiddenFiles++;
    else includedFiles++;

    const rowsLen = entry.rows?.length ?? 0;
    trackedRowsAll += rowsLen;
    if (!isHidden) trackedRowsIncluded += rowsLen;

    for (const r of entry.rows ?? []) uniqueAll.add(r);
    if (!isHidden) for (const r of entry.rows ?? []) uniqueIncluded.add(r);

    let rel = key;
    let missing = false;
    let stale = false;

    try {
      const uri = vscode.Uri.parse(key);
      rel = vscode.workspace.asRelativePath(uri, false);

      try {
        const st = await vscode.workspace.fs.stat(uri);
        stale = st.mtime !== entry.mtimeMs;
      } catch {
        missing = true;
      }

      files.push({
        uri: uri.toString(),
        rel,
        rows: rowsLen,
        mtimeMs: entry.mtimeMs,
        stale,
        missing,
        hidden: isHidden,
      });
    } catch {
      files.push({
        uri: key,
        rel,
        rows: rowsLen,
        mtimeMs: entry.mtimeMs,
        stale: false,
        missing: true,
        hidden: isHidden,
      });
    }
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel));

  host.post({
    type: "stats",
    stats: {
      dbPath,
      dbExists,
      dbSizeBytes,
      dbMtimeMs,
      nextRow,

      embeddingModel: deps.config.data.openai.embeddingModel,
      chatModel: deps.config.data.openai.modelHeavy,
      rag: deps.config.data.rag,

      totalFiles,
      includedFiles,
      hiddenFiles,

      trackedRowsAll,
      trackedRowsIncluded,
      uniqueRowsAll: uniqueAll.size,
      uniqueRowsIncluded: uniqueIncluded.size,

      files,
    },
  });
}

export async function handleQuery(
  host: DbHost,
  deps: DbDeps,
  raw: string,
  k?: number,
  maxChars?: number,
  metric?: RagMetric
): Promise<void> {
  const question = (raw ?? "").trim();
  if (!question) return;

  await deps.config.ensure();

  // Don’t query against stale included files.
  await ensureFreshIncludedIndex(host, deps, 50);

  const useK = clampInt(k, deps.config.data.rag.k, 1, 200);
  const useMax = clampInt(maxChars, deps.config.data.rag.maxChars, 200, 2_000_000);
  const useMetric: RagMetric = coerceMetric(metric, deps.config.data.rag.metric);

  host.status("Embedding query…");
  const [qVec] = await deps.openai.embedTexts([question]);

  host.status(`Querying DB (top ${useK}, ${useMetric})…`);
  const context = await deps.store.queryContext(qVec, useK, useMetric, useMax);

  const relToUri = buildRelToUriMap(deps.manifest);

  const rawParts = String(context ?? "")
    .split("\n---\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const hits: QueryHit[] = rawParts.map((part, i) => {
    const parsed = parseStoredChunk(part);
    const rel = parsed.rel ? normalizeRel(parsed.rel) : undefined;
    const uri = rel ? relToUri.get(rel) : undefined;

    return {
      index: i + 1,
      rel,
      uri,
      chunking: parsed.chunking,
      text: parsed.text,
    };
  });

  const truncated = useMax > 0 && (context ?? "").length >= useMax;

  const payload: QueryResultPayload = {
    question,
    params: { k: useK, maxChars: useMax, metric: useMetric },
    truncated,
    hits,
    rawContext: context || "",
  };

  host.status("");
  host.post({ type: "queryResult", payload });
}

export async function handleDbMessage(host: DbHost, deps: DbDeps, msg: WebviewIn): Promise<void> {
  if (msg.type === "ready" || msg.type === "refresh") {
    await sendStats(host, deps);
    return;
  }

  if (msg.type === "openFile") {
    const uri = vscode.Uri.parse(msg.uri);
    await vscode.commands.executeCommand("vscode.open", uri);
    return;
  }

  if (msg.type === "openConfig") {
    // Best-effort; if the command doesn’t exist, provider guard will surface it.
    await vscode.commands.executeCommand("idyicyanere.openConfig");
    return;
  }

  if (msg.type === "setApiKey") {
    await vscode.commands.executeCommand("idyicyanere.setApiKey");
    return;
  }

  if (msg.type === "reindexFile") {
    const uri = vscode.Uri.parse(msg.uri);
    await host.withProgress("Reindexing…", uri, () => deps.indexer.indexFile(uri));
    deps.onIndexMutated?.(uri);
    await sendStats(host, deps);
    return;
  }

  if (msg.type === "setHidden") {
    const uri = vscode.Uri.parse(msg.uri);
    const hidden = !!msg.hidden;
    await host.withProgress(hidden ? "Hiding…" : "Unhiding…", uri, () => deps.indexer.setHidden(uri, hidden));
    deps.onIndexMutated?.(uri);
    await sendStats(host, deps);
    return;
  }

  if (msg.type === "purgeFile") {
    const uri = vscode.Uri.parse(msg.uri);
    await host.withProgress("Purging…", uri, () => deps.indexer.purgeFile(uri));
    deps.onIndexMutated?.(uri);
    await sendStats(host, deps);
    return;
  }

  if (msg.type === "fix") {
    await deps.config.ensure();

    host.status("Fixing stale files (reindexing)…");
    const refresh = await deps.indexer.reindexStaleIncluded({
      limit: 5000,
      onProgress: (s) => host.status(s),
    });

    if (refresh.found > 0) log.info("DB Fix: refreshed stale files", refresh);
    else log.debug("DB Fix: no stale included files found");

    deps.onIndexMutated?.(); // global
    await sendStats(host, deps);

    host.status("");
    return;
  }

  if (msg.type === "query") {
    await handleQuery(host, deps, msg.text, msg.k, msg.maxChars, msg.metric);
    return;
  }

  if (msg.type === "clientError") {
    log.error("DB webview JS error", { text: msg.text, stack: msg.stack });
    return;
  }

  // Unknown message: don’t silently ignore.
  host.error(`Unknown message type: ${(msg as any)?.type ?? "(missing type)"}`);
}
