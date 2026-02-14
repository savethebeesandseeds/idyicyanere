import { OpenAIService } from "../../openai/openaiService";
import { PlannerConfig } from "./tools/types";
import { errMsg, previewHeadTail, clampInt, normalizeRel, validatePhaseA, validatePhaseB } from "./tools/utils";
import { ModeSession } from "./tools/modeSession";

import type {
  ContextZero,
  ChangeDescription,
  UnitSplitOut,
  UnitChange
} from "./prompts";

import { buildChangeDescription } from "./phaseA_planning";
import { splitIntoUnits } from "./phaseB_unitChanges";
import { finalizeFiles, type PhaseCOut } from "./phaseC_fileFinalizer";

export type PipelineResult = {
  phaseA: ChangeDescription;
  phaseB: UnitSplitOut;
  phaseC: PhaseCOut;
};

function wrapPhaseError(phaseTag: string, e: unknown): Error {
  const msg = errMsg(e);
  const out = new Error(`${phaseTag} ${msg}`);
  (out as any).cause = e;
  return out;
}

function groupEditsByFile(edits: UnitChange[]): { file: string; edits: UnitChange[] }[] {
  const by = new Map<string, { file: string; edits: { idx: number; e: UnitChange }[] }>();
  (edits ?? []).forEach((e, idx) => {
    const file = String((e as any)?.file ?? "").trim();
    if (!file) return;
    if (!by.has(file)) by.set(file, { file, edits: [] });
    by.get(file)!.edits.push({ idx, e });
  });

  return Array.from(by.values()).map((g) => ({
    file: g.file,
    edits: g.edits.sort((a, b) => a.idx - b.idx).map((x) => x.e)
  }));
}

export async function runPipeline(params: {
  c0: ContextZero;
  cfg: PlannerConfig;
  openai: OpenAIService;
  status: (s: string) => void;
  modeSession: ModeSession;

  // knobs
  parallelUnits?: number; // default: cfg.parallel?.unitChanges ?? 4
  max_attempt?: number;   // default: 2
}): Promise<PipelineResult> {
  const t0 = Date.now();

  // Harden status so a UI glitch doesn't kill the pipeline.
  const status = (s: string) => {
    try {
      params.status(s);
    } catch (e) {
      params.modeSession.diag?.push(`[pipeline] status handler threw: ${errMsg(e)}`);
    }
  };

  const parallelUnits = clampInt(
    (params as any)?.parallelUnits ?? (params.cfg as any)?.parallel?.unitChanges ?? 4,
    1,
    64,
    4
  );

  const max_attempt = clampInt((params as any)?.max_attempt ?? 2, 1, 10, 2);

  const getCfgModels = () => {
    const cfg: any = params.cfg as any;
    return cfg?.models ?? cfg?.model ?? cfg?.openai?.models ?? cfg?.openai?.model ?? undefined;
  };

  const getOpenAIModelHint = () => {
    const oa: any = params.openai as any;
    return oa?.model ?? oa?.cfg?.model ?? oa?.cfg?.models ?? oa?.defaults?.model ?? oa?.client?.model ?? undefined;
  };

  const promptText = String((params.c0 as any)?.prompt ?? "");
  const promptPreview = previewHeadTail(promptText, 2000, 800);

  params.modeSession.trace?.addEvent?.("pipeline_start", {
    startedAtMs: t0,
    modeKind: params.modeSession.kind,
    parallelUnits,
    max_attempt,
    promptChars: promptText.length,
    promptPreview,
    cfgModels: getCfgModels(),
    openaiModelHint: getOpenAIModelHint(),
    cfg: params.cfg
  });

  // Precompute available rels once (used in validations)
  const availRels = (params.c0.files ?? [])
    .map((f: any) => normalizeRel(String(f?.rel ?? "")))
    .filter(Boolean);

  // ---------------- Phase A ----------------
  let phaseA: ChangeDescription;
  try {
    status("pipeline: phaseA (change description)...");
    params.modeSession.trace?.addEvent?.("pipeline_phaseA_start", {
      atMs: Date.now(),
      modekind: params.modeSession.kind,
      cfgModels: getCfgModels(),
      openaiModelHint: getOpenAIModelHint()
    });

    const tA0 = Date.now();
    phaseA = await buildChangeDescription({
      c0: params.c0,
      mode: params.modeSession,
      cfg: params.cfg,
      openai: params.openai,
      status,
      prompt: promptText
    });
    const tA1 = Date.now();

    params.modeSession.trace?.addEvent?.("pipeline_phaseA_done", {
      ms: Math.max(0, tA1 - tA0),
      phaseA,
      phaseA_summary: (phaseA as any)?.summary,
      phaseA_planPreview:
        typeof (phaseA as any)?.plan === "string"
          ? previewHeadTail(String((phaseA as any).plan), 2000, 800)
          : undefined,
      phaseA_planChars:
        typeof (phaseA as any)?.plan === "string"
          ? String((phaseA as any).plan).length
          : undefined
    });
  } catch (e: any) {
    const msg = errMsg(e);
    params.modeSession.diag?.push(`[pipeline] phaseA failed: ${msg}`);
    params.modeSession.trace?.addEvent?.("pipeline_phaseA_failed", { msg });
    throw wrapPhaseError("<pipeline_phaseA>", e);
  }

  const vA = params.modeSession.validate("phaseA", () => validatePhaseA(phaseA, availRels));
  if (!vA.ok) {
    throw wrapPhaseError("<pipeline_phaseA_validation>", new Error(vA.issues.map((x) => x.message).join("; ")));
  }

  // ---------------- Phase B ----------------
  let phaseB: UnitSplitOut;
  try {
    status("pipeline: phaseB (compile edits)...");
    params.modeSession.trace?.addEvent?.("pipeline_phaseB_start", {
      atMs: Date.now(),
      phaseA_summary: (phaseA as any)?.summary
    });

    const tB0 = Date.now();
    phaseB = await splitIntoUnits({
      c0: params.c0,
      phaseA,
      mode: params.modeSession, // ModeSession goes into phaseB now
      cfg: params.cfg,
      openai: params.openai,
      status
    });
    const tB1 = Date.now();

    if (!Array.isArray((phaseB as any).edits) || (phaseB.edits?.length ?? 0) === 0) {
      throw new Error("Edit compile produced zero edits.");
    }

    const edits = (phaseB.edits ?? []) as any[];
    const fileCounts = new Map<string, number>();
    for (const e of edits) {
      const f = String(e?.file ?? "").trim();
      if (!f) continue;
      fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
    }

    params.modeSession.trace?.addEvent?.("pipeline_phaseB_done", {
      ms: Math.max(0, tB1 - tB0),
      phaseB,
      editCount: phaseB.edits.length,
      files: Array.from(fileCounts.entries()).map(([file, count]) => ({ file, count }))
    });
  } catch (e: any) {
    const msg = errMsg(e);
    params.modeSession.diag?.push(`[pipeline] phaseB failed: ${msg}`);
    params.modeSession.trace?.addEvent?.("pipeline_phaseB_failed", { msg });
    throw wrapPhaseError("<pipeline_phaseB>", e);
  }

  const vB = params.modeSession.validate("phaseB", () => validatePhaseB(phaseB, availRels));
  if (!vB.ok) {
    throw wrapPhaseError("<pipeline_phaseB_validation>", new Error(vB.issues.map((x) => x.message).join("; ")));
  }

  // ---------------- Phase C ----------------
  let phaseC: PhaseCOut;
  try {
    status("pipeline: phaseC (finalize + syntax check)...");
    params.modeSession.trace?.addEvent?.("pipeline_phaseC_start", {
      atMs: Date.now(),
      editCount: phaseB.edits?.length ?? 0
    });

    const tC0 = Date.now();
    phaseC = await finalizeFiles({
      c0: params.c0,
      phaseA,
      phaseB,
      mode: params.modeSession,
      cfg: params.cfg,
      openai: params.openai,
      status
    });
    const tC1 = Date.now();

    params.modeSession.trace?.addEvent?.("pipeline_phaseC_done", {
      ms: Math.max(0, tC1 - tC0),
      ok: phaseC.ok,
      summary: phaseC.summary,
      fileCount: phaseC.files.length,
      files: phaseC.files.map((f) => ({
        rel: f.rel,
        applyOk: f.applyOk,
        syntaxOk: f.syntaxOk,
        editCount: f.edits.length,
        beforeHash: f.beforeHash,
        afterHash: f.afterHash
      }))
    });

    // Record validation in ModeSession (do NOT necessarily throw; you can decide later)
    params.modeSession.validate("phaseC", () => {
      const issues: any[] = [];
      for (const f of phaseC.files ?? []) {
        if (!f.applyOk) {
          issues.push({ severity: "error", code: "apply_failed", message: `Phase C apply failed for ${f.rel}.` });
        }
        if (!f.syntaxOk) {
          const first = (f.syntaxIssues ?? []).find((x) => x.severity === "error");
          issues.push({
            severity: "error",
            code: "syntax_failed",
            message: `Phase C syntax failed for ${f.rel}: ${first?.message ?? "syntax error"}`
          });
        }
      }
      return issues;
    });
  } catch (e: any) {
    const msg = errMsg(e);
    params.modeSession.diag?.push(`[pipeline] phaseC failed: ${msg}`);
    params.modeSession.trace?.addEvent?.("pipeline_phaseC_failed", { msg });
    throw wrapPhaseError("<pipeline_phaseC>", e);
  }

  return {
    phaseA,
    phaseB,
    phaseC
  };
}
