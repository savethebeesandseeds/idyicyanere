import * as vscode from "vscode";
import { ConfigService } from "../../storage/configService";
import { ManifestService } from "../../storage/manifestService";
import { OpenAIService } from "../../openai/openaiService";
import { IdyDbStore } from "../../storage/idyDbStore";

import { runPipeline, type PipelineResult } from "../../editing/changePlanningEngine";
import { errMsg } from "../../editing/pipeline/tools/utils";

import { log } from "../../logging/logger";
import { RunRecord } from "./editState";
import { EditHost } from "./editHost";
import type { PlanMode, IncludedFile, ConsistencyIssue } from "../../editing/pipeline/tools/types";
import { makeId, normalizeRel, deriveExcludedSegments, isExcludedRel, hasNullByte } from "./editUtils";
import { PlannerTraceCollector } from "../../editing/pipeline/tools/trace";

import { ModeSession } from "../../editing/pipeline/tools/modeSession";

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

async function writePlannerTraceToWorkspace(trace: PlannerTraceCollector): Promise<vscode.Uri> {
  const wf = vscode.workspace.workspaceFolders?.[0];
  if (!wf) throw new Error("No workspace folder; cannot write trace.");

  const dir = vscode.Uri.joinPath(wf.uri, ".idyicyanere", "traces");
  await vscode.workspace.fs.createDirectory(dir);

  const file = vscode.Uri.joinPath(dir, `${trace.trace.id}.json`);
  const bytes = Buffer.from(JSON.stringify(trace.trace, null, 2), "utf8");

  await vscode.workspace.fs.writeFile(file, bytes);
  return file;
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

  // --- api key check ---
  try {
    const apiKeySet = await deps.openai.hasApiKey();
    if (!apiKeySet) {
      host.ui({ type: "error", text: "OpenAI API key not set. Run: “idyicyanere: Set OpenAI API Key”." }, "run/noApiKey");
      return;
    }
  } catch (e: any) {
    log.caught("planRun.hasApiKey", e);
    host.ui({ type: "error", text: `OpenAI key check failed: ${e?.message ?? String(e)}` }, "run/noApiKeyCheck");
    return;
  }

  const cfg = deps.config.data;
  const traceEnabled = cfg.editPlanner.trace.enabled;
  const trace = traceEnabled ? new PlannerTraceCollector({ cfg }) : undefined;

  if (traceEnabled && !trace) {
    throw new Error("trace enabled but no trace collector provided.");
  }

  await host.withBusy("EditPlan.handleRun", "Starting plan…", async () => {
    const t0 = Date.now();

    await host.ensure_index();
    if (isCancelled()) return;

    const state = host.getState();

    // supersede previous run
    const prev = host.getActiveRun();
    if (prev && !prev.closedAtMs) {
      prev.closedAtMs = Date.now();
      prev.closedReason = "superseded";
      log.info("planRun: superseded previous active run", { prevRunId: prev.id, prevCreatedAtMs: prev.createdAtMs });
    }

    const runId = makeId("run");
    const run: RunRecord = { id: runId, createdAtMs: Date.now(), prompt, files: [] };

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

    // seed UI rows
    run.files = files.map((f) => ({
      uri: f.uri.toString(),
      rel: f.rel,
      status: "planning",
      message: "Queued...",
      oldText: undefined,
      changes: [],
    }));

    host.scheduleSave();
    await host.sendState();
    if (isCancelled()) return;

    host.ui({ type: "status", text: `Planning across ${files.length} file(s)…` }, "run/runPipeline");

    const diag: string[] = [];
    (run as any).diag = diag;

    const modeSession = new ModeSession({
      kind: mode as any,
      trace,
      diag
    });

    let result: PipelineResult;
    let traceFileUri: vscode.Uri | undefined;

    try {
      const planPromise = runPipeline({
        c0: { prompt, files } as any,
        cfg: (deps.config as any).data?.planner ?? (deps.config as any).data,
        openai: deps.openai,
        modeSession, 
        status: (text) => {
          if (isCancelled()) return;
          host.ui({ type: "status", text }, "runPipeline/status");
          log.debug("runPipeline status", { runId, text });
        },
        // knobs optional:
        // parallelUnits: 4,
        // max_attempt: 2,
      });

      if (cancel) {
        const raced = await Promise.race([
          planPromise.then((r) => ({ kind: "done" as const, r })),
          cancel.wait.then(() => ({ kind: "cancel" as const })),
        ]);

        if (raced.kind === "cancel" || isCancelled()) {
          void planPromise.catch((e) => log.caught("planRun: canceled runPipeline (ignored)", e));
          return;
        }

        result = raced.r;
      } else {
        result = await planPromise;
      }
    } catch (e: any) {
      log.caught("runPipeline failed", e);
      const msg = errMsg(e);
      host.ui({ type: "error", text: `Pipeline failed: ${msg}` }, "run/pipelineFailed");
      run.planSummary = diag.length ? diag.join("\n") : msg;
      host.scheduleSave();
      await host.sendState();
      return;
    } finally {
      if (trace) {
        try {
          traceFileUri = await writePlannerTraceToWorkspace(trace);
          run.traceFileUri = traceFileUri.toString();
        } catch (e) {
          diag.push(`[trace] write failed: ${errMsg(e)}`);
        }
      }

      // Make sure the UI receives traceFileUri even if the pipeline failed/canceled.
      host.scheduleSave();
      await host.sendState();
    }

    if (isCancelled()) return;

    const editCount = (result.phaseB as any)?.edits?.length ?? 0;
    const cFiles = Array.isArray((result as any)?.phaseC?.files) ? (result as any).phaseC.files : [];
    const fileCount = cFiles.length;
    const okFileCount = cFiles.filter((x: any) => x?.applyOk === true && x?.syntaxOk === true).length;

    // --- Build per-file proposals (diff queue per file) ---
    const byRel = new Map<string, any>();
    for (const f of cFiles) {
      byRel.set(normalizeRel(String(f?.rel ?? "")), f);
    }

    // Reset all UI rows to a stable non-planning state.
    for (const f of run.files ?? []) {
      f.status = "unchanged";
      f.message = "No changes.";
      f.changes = [];
      f.oldText = undefined;
    }

    // Fill touched files from Phase C.
    for (const f of run.files ?? []) {
      const rel = normalizeRel(String(f.rel ?? ""));
      const fr = byRel.get(rel);
      if (!fr) continue;

      const beforeText = String(fr.beforeText ?? "");
      const afterText = String(fr.afterText ?? "");
      const edits = Array.isArray(fr.edits) ? fr.edits : [];

      f.oldText = beforeText;
      f.changes = edits.map((e: any, i: number) => ({
        id: makeId("chg"),
        index: i,
        start: 0,
        end: 0,
        oldText: "",
        newText: String(e?.diff ?? ""),
        applied: false,
        discarded: false,
        message: String(e?.rationale ?? "").trim() || ""
      }));

      const changed = beforeText !== afterText;
      const applyOk = fr.applyOk === true;
      const syntaxOk = fr.syntaxOk === true;

      if (applyOk && syntaxOk) {
        f.status = changed ? "changed" : "unchanged";
      } else {
        f.status = "error";
      }

      const syntaxErrs = (Array.isArray(fr.syntaxIssues) ? fr.syntaxIssues : [])
        .filter((x: any) => String(x?.severity ?? "").toLowerCase() === "error").length;

      f.message = [
        `edits: ${edits.length}`,
        applyOk ? "apply: ok" : "apply: failed",
        syntaxOk ? "syntax: ok" : `syntax: ${syntaxErrs} error(s)`
      ].join(" · ");
    }

    // --- Consistency issues (JSON so the webview can render) ---
    const issues: ConsistencyIssue[] = [];

    for (const v of modeSession.validations ?? []) {
      for (const it of v.issues ?? []) {
        issues.push({
          severity: it.severity === "error" ? "error" : "warn",
          message: `[${v.phase}] ${String(it.message ?? "").trim()}`,
          code: it.code,
          source: "diagnostic"
        });
      }
    }

    for (const fr of cFiles) {
      const rel = normalizeRel(String(fr?.rel ?? ""));

      if (fr?.applyOk === false) {
        issues.push({
          severity: "error",
          rel,
          message: "Finalize apply failed for this file (one or more diffs did not apply cleanly).",
          suggestion: "Re-run, or edit the failing diff in the UI.",
          source: "apply"
        });

        const applyIssues = Array.isArray(fr?.applyIssues) ? fr.applyIssues : [];
        for (const ai of applyIssues.slice(0, 6)) {
          issues.push({
            severity: String(ai?.severity ?? "").toLowerCase() === "error" ? "error" : "warn",
            rel,
            message: String(ai?.message ?? "").trim() || "Apply issue",
            source: "apply",
            code: ai?.code
          });
        }
      }

      const sIssues = Array.isArray(fr?.syntaxIssues) ? fr.syntaxIssues : [];
      for (const si of sIssues.slice(0, 12)) {
        const sev = String(si?.severity ?? "").toLowerCase() === "error" ? "error" : "warn";
        const loc =
          (si?.line != null)
            ? `:${si.line}${si?.col != null ? `:${si.col}` : ""}`
            : "";
        issues.push({
          severity: sev,
          rel,
          message: `Syntax${loc}: ${String(si?.message ?? "").trim()}`,
          source: "semantic",
          code: si?.code
        });
      }
    }

    run.consistencyIssues = issues;
    run.consistencySummary = JSON.stringify({
      summary: String((result as any)?.phaseC?.summary ?? `finalized files=${fileCount}`),
      issues
    }, null, 2);

    const hasErrors = issues.some((x) => x.severity === "error");
    const planStatus = hasErrors ? "issues" : "ok";

    // Provide markers the existing webview badge parser recognizes.
    const traceId = trace?.trace?.id;
    const traceFile = traceFileUri ? traceFileUri.toString() : "";
    run.planSummary = [
      `PLAN STATUS: ${planStatus}`,
      `MODE: ${String(modeSession.kind ?? mode)}`,
      `UNITS: ${editCount}`,
      `FILES: ${fileCount}`,
      `OK_FILES: ${okFileCount}`,
      traceId ? `TRACE ID: ${traceId}` : "",
      traceFile ? `TRACE FILE: ${traceFile}` : "",
      "",
      "PHASE A PLAN:",
      String((result as any)?.phaseA?.plan ?? ""),
      "",
      "PHASE A NOTES:",
      String((result as any)?.phaseA?.notes ?? ""),
      "",
      "PHASE B SUMMARY:",
      String((result as any)?.phaseB?.summary ?? ""),
      "",
      "PHASE C SUMMARY:",
      String((result as any)?.phaseC?.summary ?? ""),
      ...(diag.length ? ["", "DIAG:", ...diag] : [])
    ].filter(Boolean).join("\n");

    run.telemetry = {
      msTotal: Date.now() - t0,
      mode: (String(modeSession.kind) === "execute") ? "execute" : "plan",
      units: editCount,
      diag: diag.slice(0, 120),
      traceId
    };

    host.scheduleSave();
    await host.sendState();

    const doneMsg = `Done. Units=${editCount}. Files OK=${okFileCount}/${fileCount}.`;
    log.info("planRun: finished", { runId, msTotal: Date.now() - t0, editCount, fileCount, okFileCount });
    host.ui({ type: "status", text: doneMsg }, "run/doneStatus");
  });
}
