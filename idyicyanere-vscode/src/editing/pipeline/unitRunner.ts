// src/editing/pipeline2/unitRunner.ts
import { OpenAIService } from "../../openai/openaiService";
import { ConsistencyIssue, ProposedChange } from "../editTypes";
import { ChangeDescription, IncludedFile, Planner2Config, RagStoreLike, ReadTextFileResult, UnitChange, UnitTarget } from "./commons";
import { PROMPT_UNIT_VALIDATE } from "./prompts";
import { pickTargetForUnit } from "./targeting";
import {
  computeMinimalHunk,
  errMsg,
  looksLikePromptLeak,
  makeChangeId,
  normalizeRel,
  previewHeadTail,
  ResolvedMode,
  sevRank
} from "./utils";
import type { PlannerTraceCollector } from "./trace";

type ReadCached = (f: IncludedFile) => Promise<ReadTextFileResult>;

export type UnitResult = {
  unit: UnitChange;
  target: UnitTarget | null;
  issues: ConsistencyIssue[];
  change: ProposedChange | null;
  ok: boolean;
  attempts: number;
};

function buildUnitEditPrompt(params: {
  mode: ResolvedMode;
  userPrompt: string;
  changeDescription?: ChangeDescription | null;
  unit: UnitChange;
  attempt: number;
  issues?: ConsistencyIssue[];
}): string {
  const blocks: string[] = [];

  blocks.push(`MODE: ${String(params.mode ?? "").toUpperCase()}`);
  blocks.push("");

  blocks.push("REQUEST:");
  blocks.push(String(params.userPrompt ?? "").trim());

  if (params.mode === "plan" && params.changeDescription) {
    blocks.push("");
    blocks.push("PLAN_JSON:");
    blocks.push(JSON.stringify({
      summary: params.changeDescription.summary ?? "",
      description: params.changeDescription.description ?? "",
      assumptions: params.changeDescription.assumptions ?? undefined,
      constraints: params.changeDescription.constraints ?? undefined,
      nonGoals: params.changeDescription.nonGoals ?? undefined,
      acceptanceCriteria: params.changeDescription.acceptanceCriteria ?? undefined,
      risks: params.changeDescription.risks ?? undefined
    }, null, 2));
  }

  blocks.push("");
  blocks.push("UNIT_JSON:");
  blocks.push(JSON.stringify({
    id: params.unit.id,
    title: params.unit.title,
    instructions: params.unit.instructions,
    fileHints: params.unit.fileHints ?? undefined,
    anchors: params.unit.anchors ?? undefined,
    acceptanceCriteria: params.unit.acceptanceCriteria ?? undefined
  }, null, 2));

  blocks.push("");
  blocks.push("EDIT CONTRACT (STRICT):");
  blocks.push("- You will be provided a code FRAGMENT plus read-only surrounding context.");
  blocks.push("- Modify ONLY the fragment. Treat surrounding context as immutable reference.");
  blocks.push("- Make the smallest change that satisfies UNIT_JSON.instructions.");
  blocks.push("- Do NOT introduce unrelated refactors, renames, reformatting, or style-only changes.");
  blocks.push("- Preserve indentation, whitespace conventions, and line endings unless the request explicitly asks for formatting.");
  blocks.push("- Do not add placeholders, TODOs, or commented-out code unless explicitly required by the unit.");
  blocks.push("- If you cannot confidently implement the unit within the fragment WITHOUT GUESSING about unseen code, output the fragment EXACTLY unchanged.");
  blocks.push("- Output MUST be ONLY the updated fragment text. No markdown, no explanations, no headings.");

  if (params.attempt > 0 && params.issues?.length) {
    blocks.push("");
    blocks.push(`REVISION_NOTES_${params.attempt}:`);
    for (const iss of params.issues.slice(0, 30)) {
      const sug = iss.suggestion ? ` | suggestion: ${String(iss.suggestion).trim()}` : "";
      blocks.push(`- [${iss.severity}] ${String(iss.message).trim()}${sug}`);
    }
  }

  return blocks.join("\n");
}

function toSemanticIssues(rel: string, raw: any): ConsistencyIssue[] {
  const issues = Array.isArray(raw?.issues) ? raw.issues : [];
  return issues
    .map((x: any) => ({
      severity: x?.severity === "error" ? "error" : "warn",
      rel,
      message: String(x?.message ?? "").trim(),
      suggestion: x?.suggestion ? String(x.suggestion).trim() : undefined,
      source: "semantic" as const
    }))
    .filter((x: ConsistencyIssue) => !!x.message);
}

function clampRange(start: number, end: number, len: number): { start: number; end: number } {
  let s = Math.trunc(Number(start));
  let e = Math.trunc(Number(end));
  if (!Number.isFinite(s)) s = 0;
  if (!Number.isFinite(e)) e = 0;
  s = Math.max(0, Math.min(len, s));
  e = Math.max(0, Math.min(len, e));
  if (e < s) [s, e] = [e, s];
  return { start: s, end: e };
}

export async function runUnitChange(params: {
  cfg: Planner2Config;
  mode: ResolvedMode;
  userPrompt: string;
  changeDescription: ChangeDescription | null;
  unit: UnitChange;
  unitIndex: number;

  files: IncludedFile[];
  relToIndex: Map<string, number>;
  readCached: ReadCached;
  ragStore?: RagStoreLike;

  openai: OpenAIService;
  status: (s: string) => void;
  trace?: PlannerTraceCollector;
}): Promise<UnitResult> {
  const unitT0 = Date.now();
  const issues: ConsistencyIssue[] = [];

  try {
    params.status(`Unit ${params.unitIndex + 1}: targeting ${params.unit.title} …`);

    const pick = await pickTargetForUnit({
      cfg: params.cfg,
      unit: params.unit,
      userPrompt: params.userPrompt,
      files: params.files,
      relToIndex: params.relToIndex,
      readCached: params.readCached,
      ragStore: params.ragStore,
      openai: params.openai,
      trace: params.trace
    });

    if (!pick.target) {
      issues.push({
        severity: "error",
        message: "Could not resolve target file/region for unit.",
        suggestion: "Add clearer fileHints/anchors or split units further.",
        source: "router"
      });

      params.trace?.addEvent("unit_failed_no_target", { unitId: params.unit.id, title: params.unit.title });
      return { unit: params.unit, target: null, issues, change: null, ok: false, attempts: 0 };
    }

    const target = pick.target;
    const relN = normalizeRel(target.rel);

    const fileIdx = params.relToIndex.get(relN);
    if (typeof fileIdx !== "number") {
      issues.push({
        severity: "error",
        rel: relN,
        message: "Target rel resolved but not present in candidate file list.",
        suggestion: "Check routing/candidate file list generation.",
        source: "router"
      });
      return { unit: params.unit, target, issues, change: null, ok: false, attempts: 0 };
    }

    const f = params.files[fileIdx];
    const read = pick.fileText ? ({ ok: true as const, text: pick.fileText }) : await params.readCached(f);

    if (!read.ok) {
      issues.push({
        severity: "error",
        rel: relN,
        message: `Failed to read target file: ${read.reason}`,
        suggestion: "Check filesystem/workspace state.",
        source: "planner"
      });

      params.trace?.addEvent("unit_failed_read", { unitId: params.unit.id, rel: relN, reason: read.reason });
      return { unit: params.unit, target, issues, change: null, ok: false, attempts: 0 };
    }

    const fileText = read.text;

    const r = clampRange(target.start, target.end, fileText.length);
    const regionStart = r.start;
    const regionEnd = r.end;

    const baselineFrag = fileText.slice(regionStart, regionEnd);

    const ctxChars = Math.max(0, params.cfg.segmentation.contextChars);
    const beforeCtx = fileText.slice(Math.max(0, regionStart - ctxChars), regionStart);
    const afterCtx = fileText.slice(regionEnd, Math.min(fileText.length, regionEnd + ctxChars));

    let lastIssues: ConsistencyIssue[] = [];
    let accepted: ProposedChange | null = null;
    let attempts = 0;

    for (let round = 0; round < params.cfg.attempts.maxRounds; round++) {
      attempts = round + 1;

      const prompt = buildUnitEditPrompt({
        mode: params.mode,
        userPrompt: params.userPrompt,
        changeDescription: params.changeDescription,
        unit: params.unit,
        attempt: round,
        issues: lastIssues
      });

      const label = `${round === 0 ? "propose" : "repair"} ${round + 1}/${params.cfg.attempts.maxRounds} [${regionStart}..${regionEnd}]`;

      let newFrag = baselineFrag;

      try {
        newFrag = await params.openai.editFragment(
          prompt,
          relN,
          label,
          baselineFrag,
          beforeCtx,
          afterCtx,
          params.cfg.models.modelHeavy
        );
      } catch (e: any) {
        lastIssues = [{
          severity: "error",
          rel: relN,
          message: `Model failed to propose edit: ${errMsg(e)}`,
          suggestion: "Retry; if persistent, reduce fragment size or check model availability.",
          source: "planner"
        }];
        continue;
      }

      if (looksLikePromptLeak(newFrag)) {
        lastIssues = [{
          severity: "error",
          rel: relN,
          message: "Model output appears to include prompt/instructions (prompt leak).",
          suggestion: "Retry; enforce fragment-only output.",
          source: "planner"
        }];
        continue;
      }

      const hunk = computeMinimalHunk({ segStart: regionStart, oldSeg: baselineFrag, newSeg: newFrag });

      const ch: ProposedChange = {
        id: makeChangeId(relN, hunk.start, hunk.end, params.unit.id),
        index: params.unitIndex, // v2 uses unit index here
        start: hunk.start,
        end: hunk.end,
        oldText: hunk.oldText,
        newText: hunk.newText,
        applied: false,
        discarded: false,
        message: `Unit: ${params.unit.title}`
      };

      // Mark no-op as discarded (but still validate it below).
      if (hunk.oldText === "" && hunk.newText === "") {
        ch.discarded = true;
        ch.message = "No-op (fragment unchanged)";
      }

      // Validate (semantic) — light by default
      try {
        const validateModelOverride =
          params.cfg.attempts.validateModel === "heavy" ? params.cfg.models.modelHeavy : params.cfg.models.modelLight;
        const validateModelKind = params.cfg.attempts.validateModel === "heavy" ? "heavy" : "light";

        const val = await params.openai.completeJson<any>({
          modelKind: validateModelKind,
          modelOverride: validateModelOverride,
          instructions: PROMPT_UNIT_VALIDATE,
          input: [
            `TARGET FILE: ${relN}`,
            "",
            "UNIT (JSON):",
            JSON.stringify(params.unit, null, 2),
            "",
            "PROPOSED HUNK:",
            `range: [${ch.start}..${ch.end}]`,
            "",
            "FRAGMENT BEFORE (preview):",
            JSON.stringify(previewHeadTail(baselineFrag, 2600, 900), null, 2),
            "",
            "FRAGMENT AFTER (preview):",
            JSON.stringify(previewHeadTail(newFrag, 2600, 900), null, 2),
            "",
            "oldText (preview):",
            JSON.stringify(previewHeadTail(ch.oldText, 1800, 600), null, 2),
            "",
            "newText (preview):",
            JSON.stringify(previewHeadTail(ch.newText, 1800, 600), null, 2),
            "",
            "LOCAL CONTEXT BEFORE (preview):",
            JSON.stringify(previewHeadTail(beforeCtx, 1200, 400), null, 2),
            "",
            "LOCAL CONTEXT AFTER (preview):",
            JSON.stringify(previewHeadTail(afterCtx, 1200, 400), null, 2)
          ].join("\n"),
          maxRetries: 1
        });

        const vIssues = toSemanticIssues(relN, val);
        const ok = !!val?.ok && !vIssues.some((x) => sevRank(x.severity) >= 2);

        if (ok) {
          accepted = ch;
          lastIssues = vIssues;
          break;
        }

        lastIssues = vIssues.length
          ? vIssues
          : [{
              severity: "error",
              rel: relN,
              message: "Validator marked unit as not OK but returned no issues.",
              suggestion: "Retry validation with heavier model or add more context.",
              source: "semantic"
            }];
      } catch (e: any) {
        // If validation fails, accept but warn.
        lastIssues = [{
          severity: "warn",
          rel: relN,
          message: `Unit validation failed and was skipped: ${errMsg(e)}`,
          suggestion: "Proceed; final file validation may catch issues.",
          source: "semantic"
        }];
        accepted = ch;
        break;
      }
    }

    if (!accepted) {
      issues.push(...lastIssues);
      params.trace?.addEvent("unit_failed_after_attempts", {
        unitId: params.unit.id,
        rel: relN,
        attempts,
        issues: lastIssues.map((x) => ({ severity: x.severity, message: x.message, source: (x as any).source }))
      });

      return { unit: params.unit, target, issues, change: null, ok: false, attempts };
    }

    issues.push(...lastIssues);

    const ok = !issues.some((x) => sevRank(x.severity) >= 2);

    params.trace?.addEvent("unit_done", {
      unitId: params.unit.id,
      title: params.unit.title,
      rel: relN,
      region: { start: target.start, end: target.end, why: target.why },
      attempts,
      accepted: { start: accepted.start, end: accepted.end, oldLen: accepted.oldText.length, newLen: accepted.newText.length, discarded: accepted.discarded },
      issues: issues.slice(0, 30).map((x) => ({ severity: x.severity, message: x.message, source: (x as any).source }))
    });

    params.trace?.addStep("unit_total", unitT0, Date.now(), { unitId: params.unit.id, rel: relN, attempts });

    return { unit: params.unit, target, issues, change: accepted, ok, attempts };
  } catch (e: any) {
    const msg = errMsg(e);
    issues.push({ severity: "error", message: `Unit processing failed: ${msg}`, suggestion: "Retry.", source: "planner" });

    params.trace?.addEvent("unit_exception", { unitId: params.unit.id, msg });

    return { unit: params.unit, target: null, issues, change: null, ok: false, attempts: 0 };
  }
}
