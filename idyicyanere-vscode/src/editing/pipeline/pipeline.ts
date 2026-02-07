// src/editing/pipeline2/pipeline.ts
import { log } from "../../logging/logger";
import { ProposedFile, ConsistencyIssue, ProposedChange } from "../editTypes";

import {
  ApplyCheckReport,
  ChangeDescription,
  IncludedFile,
  PlanChangesParams,
  UnitChange,
  loadPlanner2Config
} from "./commons";

import { PlannerTraceCollector } from "./trace";
import { writeReasoningTraceFile } from "./traceWriter";
import { buildChangeDescription } from "./phaseA_changeDescription";
import { splitIntoUnits } from "./phaseA_unitSplit";
import { runUnitChange, UnitResult } from "./unitRunner";
import { finalizeFile, FileUnitSummary } from "./fileFinalizer";

import { errMsg, normalizeRel, resolveMode, runPool, sevRank, ResolvedMode } from "./utils";

type PlannerTelemetry = {
  msTotal: number;
  mode: ResolvedMode;
  units: number;
  diag: string[];

  // Optional (filled if trace enabled/written)
  traceFile?: string;
  traceId?: string;
  traceWriteError?: string;
};

function dedupeIssues(issues: ConsistencyIssue[]): ConsistencyIssue[] {
  const seen = new Set<string>();
  const out: ConsistencyIssue[] = [];

  for (const iss of issues ?? []) {
    const rel = normalizeRel(iss.rel ?? "");
    const key = `${iss.severity}|${rel}|${String(iss.message ?? "").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...iss, rel: rel || iss.rel });
  }

  return out;
}

export async function planChanges(params: PlanChangesParams): Promise<{
  plan?: any;
  planMeta: any;

  applyCheck?: any;
  consistency?: any;
  files: ProposedFile[];

  telemetry?: any;
}> {
  const t0 = Date.now();
  await params.config.ensure();

  const cfg = loadPlanner2Config(params.config);
  const mode = resolveMode(params.mode, params.prompt);
  const status = (s: string) => params.onStatus?.(s);

  const diag: string[] = [];

  const relToIndex = new Map<string, number>();
  for (let i = 0; i < params.files.length; i++) relToIndex.set(normalizeRel(params.files[i].rel), i);

  // Trace collector
  let trace: PlannerTraceCollector | undefined;
  if (cfg.trace.enabled) {
    trace = new PlannerTraceCollector({
      prompt: String(params.prompt ?? ""),
      mode,
      cfg,
      inputFiles: (params.files ?? []).map((f) => ({
        rel: String(f.rel ?? ""),
        uri: f.uri?.toString?.() ?? String(f.uri ?? ""),
        chunkChars: Math.trunc(Number((f as any)?.chunkChars ?? 0)) || 0
      }))
    });
  }

  // File read cache
  const fileTextCache = new Map<string, Promise<any>>();
  const readCached = (f: IncludedFile) => {
    const key = f.uri.toString();
    let p = fileTextCache.get(key);
    if (!p) {
      p = params.readTextFile(f.uri);
      fileTextCache.set(key, p);
    }
    return p as any;
  };

  // Empty prompt guard (optional but nice)
  const prompt = String(params.prompt ?? "").trim();
  if (!prompt) {
    const files: ProposedFile[] = params.files.map((f) => ({
      uri: f.uri.toString(),
      rel: normalizeRel(f.rel),
      status: "skipped",
      message: "No prompt provided.",
      oldText: undefined,
      changes: []
    }));

    for (let i = 0; i < files.length; i++) params.onFileResult?.(i, files[i]);

    const telemetry: PlannerTelemetry = {
      msTotal: Date.now() - t0,
      mode,
      units: 0,
      diag: []
    };

    const ret = {
      plan: null,
      planMeta: {
        status: "need_input",
        explanation: "No prompt provided.",
        questions: ["What change do you want to make?"]
      },
      applyCheck: null,
      consistency: {
        summary: "No changes planned (need input).",
        issues: [{ severity: "warn", message: "No prompt provided." }]
      },
      files,
      telemetry
    };

    if (trace) {
      trace.setFinal({ planMeta: ret.planMeta, files: { total: files.length } });
      const uri = await writeReasoningTraceFile(params, trace.trace);
      if (uri) {
        telemetry.traceFile = uri.toString();
        telemetry.traceId = trace.trace.id;
      }
    }

    return ret;
  }

  // ---------------- Phase A ----------------
  const changeDescription: ChangeDescription = await buildChangeDescription({
    mode,
    prompt,
    cfg,
    openai: params.openai,
    status,
    diag,
    trace,
    files: params.files
  });

  const units: UnitChange[] = await splitIntoUnits({
    prompt,
    changeDescription,
    cfg,
    openai: params.openai,
    status,
    diag,
    trace,
    files: params.files
  });

  // ---------------- Phase B (parallel per unit) ----------------
  const unitResults: UnitResult[] = new Array(units.length);

  await runPool(
    units.map((u, idx) => ({ u, idx })),
    cfg.parallel.unitChanges,
    async ({ u, idx }) => {
      const r = await runUnitChange({
        cfg,
        mode,
        userPrompt: prompt,
        changeDescription,
        unit: u,
        unitIndex: idx,
        files: params.files,
        relToIndex,
        readCached,
        ragStore: params.ragStore,
        openai: params.openai,
        status,
        trace
      });

      unitResults[idx] = r;
    }
  );

  // ---------------- Phase C (parallel per file) ----------------
  type FileGroup = {
    fileIndex: number;
    file: IncludedFile;
    rel: string;
    changes: ProposedChange[];
    unitIssues: ConsistencyIssue[];
    unitsForFile: FileUnitSummary[];
  };

  const groups = new Map<string, FileGroup>();

  for (const ur of unitResults) {
    if (!ur?.target?.rel) continue;
    const rel = normalizeRel(ur.target.rel);
    const fileIndex = relToIndex.get(rel);
    if (typeof fileIndex !== "number") continue;

    let g = groups.get(rel);
    if (!g) {
      g = {
        fileIndex,
        file: params.files[fileIndex],
        rel,
        changes: [],
        unitIssues: [],
        unitsForFile: []
      };
      groups.set(rel, g);
    }

    if (ur.change) g.changes.push(ur.change);

    for (const iss of ur.issues ?? []) {
      g.unitIssues.push({ ...iss, rel: rel });
    }

    // unique unit summaries for this file (used in final file validation)
    if (!g.unitsForFile.some((x) => x.id === ur.unit.id)) {
      g.unitsForFile.push({
        id: ur.unit.id,
        title: ur.unit.title,
        instructions: ur.unit.instructions,
        acceptanceCriteria: ur.unit.acceptanceCriteria
      });
    }
  }

  const results: ProposedFile[] = new Array(params.files.length);
  const applyFiles: ApplyCheckReport["files"] = [];
  const allIssues: ConsistencyIssue[] = [];

  await runPool(Array.from(groups.values()), cfg.parallel.files, async (g) => {
    status(`Finalizing file: ${g.rel} …`);

    const read = await readCached(g.file);
    if (!read.ok) {
      const pf: ProposedFile = {
        uri: g.file.uri.toString(),
        rel: g.rel,
        status: "error",
        message: `Failed to read file: ${read.reason}`,
        oldText: undefined,
        changes: []
      };
      results[g.fileIndex] = pf;
      params.onFileResult?.(g.fileIndex, pf);

      allIssues.push({
        severity: "error",
        rel: g.rel,
        message: `Failed to read file: ${read.reason}`,
        suggestion: "Check filesystem/workspace state.",
        source: "apply"
      });

      return;
    }

    const fin = await finalizeFile({
      cfg,
      userPrompt: prompt,
      rel: g.rel,
      uri: g.file.uri.toString(),
      oldText: read.text,
      changes: g.changes,
      unitIssues: g.unitIssues,
      unitsForFile: g.unitsForFile,
      openai: params.openai
    });

    results[g.fileIndex] = fin.proposedFile;
    params.onFileResult?.(g.fileIndex, fin.proposedFile);

    applyFiles.push(fin.applyCheckFile);
    allIssues.push(...fin.issues);

    trace?.addEvent("file_done", {
      rel: g.rel,
      status: fin.proposedFile.status,
      message: fin.proposedFile.message,
      applyOk: fin.applyCheckFile.ok,
      issueCount: fin.issues.length
    });
  });

  // Fill untouched files
  for (let i = 0; i < params.files.length; i++) {
    if (results[i]) continue;

    const f = params.files[i];
    const pf: ProposedFile = {
      uri: f.uri.toString(),
      rel: normalizeRel(f.rel),
      status: "unchanged",
      message: "Untouched",
      oldText: undefined,
      changes: []
    };
    results[i] = pf;
    params.onFileResult?.(i, pf);
  }

  // Apply report
  const applyIssues = applyFiles.flatMap((f) => f.issues ?? []);
  const applyOk = applyIssues.every((x) => sevRank(x.severity) < 2);

  const applyCheck: ApplyCheckReport = {
    ok: applyOk,
    summary: applyIssues.length
      ? `Apply simulation found ${applyIssues.length} issue(s) across ${new Set(applyIssues.map((x) => x.rel || "")).size} file(s).`
      : "Apply simulation OK.",
    files: applyFiles.slice().sort((a, b) => a.rel.localeCompare(b.rel)),
    issues: applyIssues
  };

  // Consistency (merged issues)
  const consistencyIssues = dedupeIssues(allIssues);
  const hasErrors = consistencyIssues.some((x) => sevRank(x.severity) >= 2);

  const consistency = {
    summary: hasErrors
      ? `Validation found ${consistencyIssues.length} issue(s) (errors present).`
      : (consistencyIssues.length ? `Validation found ${consistencyIssues.length} issue(s).` : "Validation OK."),
    issues: consistencyIssues
  };

  // ✅ TELEMETRY FIX: explicitly typed object we can extend
  const telemetry: PlannerTelemetry = {
    msTotal: Date.now() - t0,
    mode,
    units: units.length,
    diag: diag.slice(0, 200)
  };

  const ret = {
    plan: changeDescription,
    planMeta: { status: "ok", explanation: changeDescription.summary },

    applyCheck,
    consistency,
    files: results,

    telemetry
  };

  // Trace writing (optional)
  if (trace) {
    try {
      trace.setFinal({
        mode,
        changeDescription,
        unitCount: units.length,
        applyCheck: { ok: applyCheck.ok, summary: applyCheck.summary },
        consistency: { summary: consistency.summary, issues: consistency.issues.slice(0, 200) }
      });

      const uri = await writeReasoningTraceFile(params, trace.trace);
      if (uri) {
        telemetry.traceFile = uri.toString();
        telemetry.traceId = trace.trace.id;
      }
    } catch (e: any) {
      telemetry.traceWriteError = errMsg(e);
    }
  }

  log.info("planChanges(v2) done", { ms: telemetry.msTotal, mode, units: units.length });
  return ret;
}
