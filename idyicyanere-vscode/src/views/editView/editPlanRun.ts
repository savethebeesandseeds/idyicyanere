import * as vscode from "vscode";
import { ConfigService } from "../../storage/configService";
import { ManifestService } from "../../storage/manifestService";
import { OpenAIService } from "../../openai/openaiService";
import { IdyDbStore } from "../../storage/idyDbStore";
import { planChanges } from "../../editing/changePlanningEngine";
import { log } from "../../logging/logger";
import { RunRecord } from "./editState";
import { EditHost } from "./editHost";
import type { PlanMode } from "../../editing/pipeline/commons";
import { makeId, normalizeRel, deriveExcludedSegments, isExcludedRel, hasNullByte } from "./editUtils";

type IncludedFile = { uri: vscode.Uri; rel: string; chunkChars: number };

type ReadTextFileResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export type PlanRunDeps = {
  config: ConfigService;
  manifest: ManifestService;
  openai: OpenAIService;
  ragStore: IdyDbStore;
};

export type CancelToken = {
  isCancelled: () => boolean;
  wait: Promise<void>;
};

const MAX_FILE_BYTES = 250_000;

async function ensureConfigAndManifest(cfg: ConfigService, manifest: ManifestService): Promise<boolean> {
  try {
    await cfg.ensure();
    await manifest.load();
    return true;
  } catch (e: any) {
    log.caught("planRun.ensureConfigAndManifest", e);
    return false;
  }
}

async function listIncludedIndexedFiles(cfg: ConfigService, manifest: ManifestService): Promise<IncludedFile[]> {
  const ok = await ensureConfigAndManifest(cfg, manifest);
  if (!ok) return [];

  const excluded = deriveExcludedSegments(cfg.data.indexing.excludeGlobs);
  const defChunk = cfg.data.indexing.chunking.default.chunkChars;

  const out: IncludedFile[] = [];

  for (const [key, entry] of manifest.entries()) {
    if (entry.included === false) continue;

    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(key);
    } catch (e: any) {
      log.warn("planRun.listIncludedIndexedFiles: bad manifest key uri", { key, error: e?.message ?? String(e) });
      continue;
    }

    if (uri.scheme !== "file") continue;
    if (!vscode.workspace.getWorkspaceFolder(uri)) continue;

    const rel = normalizeRel(vscode.workspace.asRelativePath(uri, false));
    if (!rel) continue;
    if (isExcludedRel(rel, excluded)) continue;

    const chunkChars = Math.max(500, Math.min(60000, Math.trunc(Number(entry.chunking?.chunkChars ?? defChunk))));
    out.push({ uri, rel, chunkChars });
  }

  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

async function readTextFile(uri: vscode.Uri): Promise<ReadTextFileResult> {
  let bytes: Uint8Array;

  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (e: any) {
    log.warn("planRun.readTextFile: read failed", { uri: uri.toString(), error: e?.message ?? String(e) });
    return { ok: false, reason: "read failed" };
  }

  if (bytes.byteLength > MAX_FILE_BYTES) return { ok: false, reason: `too large (${bytes.byteLength} bytes)` };
  if (hasNullByte(bytes)) return { ok: false, reason: "binary" };

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return { ok: true, text };
}

function runCounts(run: RunRecord): { total: number; applied: number; discarded: number; pending: number } {
  let total = 0, applied = 0, discarded = 0, pending = 0;
  for (const f of run.files ?? []) {
    for (const c of f.changes ?? []) {
      total++;
      if (c.discarded) discarded++;
      else if (c.applied) applied++;
      else pending++;
    }
  }
  return { total, applied, discarded, pending };
}

export async function handlePlanRun(
  host: EditHost,
  deps: PlanRunDeps,
  rawPrompt: string,
  mode: PlanMode = "plan",
  cancel?: CancelToken
): Promise<void> {
  const prompt = String(rawPrompt ?? "").trim();
  if (!prompt) return;
  
  const isCancelled = () => cancel?.isCancelled?.() === true;

  let apiKeySet = false;
  try {
    apiKeySet = await deps.openai.hasApiKey();
  } catch (e: any) {
    log.caught("planRun.hasApiKey", e);
    host.ui({ type: "error", text: `OpenAI key check failed: ${e?.message ?? String(e)}` }, "run/noApiKeyCheck");
    return;
  }

  if (!apiKeySet) {
    host.ui({ type: "error", text: "OpenAI API key not set. Run: “idyicyanere: Set OpenAI API Key”." }, "run/noApiKey");
    return;
  }

  await host.withBusy("EditPlan.handleRun", "Starting plan…", async () => {
    const t0 = Date.now();

    // Make index refresh part of the busy lifecycle (prevents concurrent clicks).
    await host.ensure_index();
    if (isCancelled()) return;

    const state = host.getState();

    // Supersede previous run.
    const prev = host.getActiveRun();
    if (prev && !prev.closedAtMs) {
      prev.closedAtMs = Date.now();
      prev.closedReason = "superseded";
      log.info("planRun: superseded previous active run", { prevRunId: prev.id, prevCreatedAtMs: prev.createdAtMs });
    }

    const runId = makeId("run");
    const run: RunRecord = {
      id: runId,
      createdAtMs: Date.now(),
      prompt,
      files: [],
    };

    state.runs.push(run);
    state.activeRunId = runId;

    host.scheduleSave();
    await host.sendState();
    if (isCancelled()) return;

    host.ui({ type: "status", text: "Collecting included indexed files…" }, "run/listIncludedFiles");

    const files = await listIncludedIndexedFiles(deps.config, deps.manifest);
    log.info("planRun: included indexed files", { runId, count: files.length });

    if (!files.length) {
      host.ui({ type: "error", text: "No included indexed files found. Check indexing config + logs." }, "run/noFiles");
      return;
    }

    // Seed UI with planning rows.
    run.files = files.map((f) => ({
      uri: f.uri.toString(),
      rel: f.rel,
      status: "planning",
      message: "Planning…",
      oldText: undefined,
      changes: [],
    }));

    host.scheduleSave();
    await host.sendState();
    if (isCancelled()) return;

    host.ui({ type: "status", text: `Planning across ${files.length} file(s)…` }, "run/planChanges");

    const planPromise = planChanges({
      prompt,
      mode,
      files,
      readTextFile,
      openai: deps.openai,
      config: deps.config,
      ragStore: deps.ragStore,
      onStatus: (text) => {
        if (isCancelled()) return;
        host.ui({ type: "status", text }, "planChanges/status");
        log.debug("planChanges status", { runId, text });
      },
      onFileResult: async (idx, pf) => {
        if (isCancelled()) return;
        if (!Number.isFinite(idx) || idx < 0 || idx >= run.files.length) {
          log.warn("planRun.onFileResult: idx out of range", { runId, idx, filesLen: run.files.length, pfRel: (pf as any)?.rel });
          return;
        }
        run.files[idx] = pf;
        host.scheduleSave();
        await host.sendState();
      },
    });

    let result: any;

    if (cancel) {
      const raced = await Promise.race([
        planPromise.then((r) => ({ kind: "done" as const, r })),
        cancel.wait.then(() => ({ kind: "cancel" as const })),
      ]);

      if (raced.kind === "cancel" || isCancelled()) {
        // IMPORTANT: swallow errors from the now-unawaited planPromise
        void planPromise.catch((e) => log.caught("planRun: canceled planChanges (ignored)", e));
        return; // exits withBusy -> clears provider.busy quickly
      }

      result = raced.r;
    } else {
      result = await planPromise;
    }

    if (isCancelled()) return;

    // Hard-set final files array (belt + suspenders).
    run.files = result.files;

    // Build plan summary for UI (v2).
    const pm: any = (result as any).planMeta;
    const tele: any = (result as any).telemetry;
    const applyCheck: any = (result as any).applyCheck;

    const planLines: string[] = [];

    // Telemetry first (if present)
    if (tele?.mode) planLines.push(`MODE: ${tele.mode}`);
    if (Number.isFinite(tele?.units)) planLines.push(`UNITS: ${tele.units}`);
    if (Number.isFinite(tele?.msTotal)) planLines.push(`TOTAL MS: ${tele.msTotal}`);

    if (tele?.traceFile) planLines.push(`TRACE FILE: ${tele.traceFile}`);
    if (tele?.traceId) planLines.push(`TRACE ID: ${tele.traceId}`);
    if (tele?.traceWriteError) planLines.push(`TRACE WRITE ERROR: ${tele.traceWriteError}`);

    // Apply simulation summary (nice context even if we only display consistency issues)
    if (applyCheck?.summary) {
      planLines.push("");
      planLines.push(`APPLY CHECK: ${applyCheck.ok ? "ok" : "issues"}`);
      planLines.push(String(applyCheck.summary));
    }

    if (pm) {
      planLines.push("");
      planLines.push(`PLAN STATUS: ${pm.status ?? "ok"}`);
      if (pm.explanation) planLines.push(`EXPLANATION: ${pm.explanation}`);

      if (Array.isArray(pm.questions) && pm.questions.length) {
        planLines.push("QUESTIONS:");
        for (const q of pm.questions) planLines.push(`- ${q}`);
      }
    }

    planLines.push("");
    planLines.push(result.plan ? JSON.stringify(result.plan, null, 2) : "(no plan)");

    run.planSummary = planLines.join("\n");
    run.telemetry = tele ?? undefined;

    // Consistency
    run.consistencySummary = result.consistency ? JSON.stringify(result.consistency, null, 2) : "(no consistency report)";
    run.consistencyIssues = result.consistency?.issues ?? [];

    // Attach per-file issue counts into file.message.
    if ((run.consistencyIssues ?? []).length) {
      const byRel = new Map<string, number>();
      for (const iss of run.consistencyIssues ?? []) {
        const rel = String((iss.rel ?? "")).trim();
        if (!rel) continue;
        byRel.set(rel, (byRel.get(rel) ?? 0) + 1);
      }

      for (const f of run.files ?? []) {
        const n = byRel.get(f.rel) ?? 0;
        if (n > 0) f.message = `${f.message ?? ""} ⚠ ${n} issue(s)`.trim();
      }
    }

    const rc = runCounts(run);
    log.info("planRun: run counts", {
      runId,
      total: rc.total,
      applied: rc.applied,
      discarded: rc.discarded,
      pending: rc.pending,
      issueCount: (run.consistencyIssues ?? []).length,
    });

    host.scheduleSave();
    await host.sendState();
    if (isCancelled()) return;

    const doneMsg =
      (run.consistencyIssues ?? []).some((x) => x.severity === "error")
        ? "Done (errors found; review validation)."
        : (run.consistencyIssues ?? []).length
        ? "Done (warnings found; review validation)."
        : "Done. Click a change to open diff, edit, then Apply.";

    log.info("planRun: finished", { runId, msTotal: Date.now() - t0 });

    host.ui({ type: "status", text: doneMsg }, "run/doneStatus");
  });
}
