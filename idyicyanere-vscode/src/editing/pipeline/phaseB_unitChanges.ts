import * as vscode from "vscode";
import { promises as fs } from "fs";

import { OpenAIService } from "../../openai/openaiService";
import { PlannerConfig, ResolvedMode } from "./tools/types";
import { errMsg, normalizeRel, runPool, hashHex } from "./tools/utils";

import { ModeSession } from "./tools/modeSession";

import {
  UnitSplitOut_TagSchema,
  UnitChange_TagSchema,
  build_input_UNIT_SPLIT,
  build_instructions_UNIT_SPLIT,
  build_input_UNIT_EDIT_REPAIR,
  build_instructions_UNIT_EDIT_REPAIR,
  ContextZero,
  ChangeDescription,
  UnitSplitOut,
  UnitChange
} from "./prompts";

import {
  formatWithLineNumbers,
  tryApplyUnifiedDiff,
  renderUnifiedDiffIssues,
  detectDominantLineEnding
} from "./tools/unitDiff";

export async function splitIntoUnits(params: {
  c0: ContextZero,
  phaseA: ChangeDescription;
  mode: ModeSession;
  cfg: PlannerConfig;
  openai: OpenAIService;
  status: (s: string) => void;
}): Promise<UnitSplitOut> {
  const t0 = Date.now();
  const modelKind = "heavy";

  const { input, trace_input } = await build_input_UNIT_SPLIT(params.c0, params.phaseA);
  const instructions: string = await build_instructions_UNIT_SPLIT(params.c0, params.phaseA);

  try {
    params.status("phaseB (compile edits): compiling change description into edit operations...");
    const out = await params.openai.language_request_with_TAGS_out<UnitSplitOut>({
      modelKind,
      instructions,
      input,
      schema: UnitSplitOut_TagSchema,
      maxRetries: 2,
      addFormatInstructions: false
    });

    if (!out.edits?.length) throw "[phaseB] <failure> Edit compiler produced zero edit(s)";

    // ---------------- Phase B.5: repair diffs safely (parallel per file, sequential per file edits) ----------------
    const lightModelKind = "light" as const;

    // Concurrency should be per-file, not per-edit, to keep per-file baselines consistent.
    const parallelFiles = Math.max(1, Math.min(32, params.cfg.parallel?.files ?? 4));
    const maxRounds = Math.max(1, Math.min(6, params.cfg.attempts?.maxRounds ?? 3));

    const repairInstructions = await build_instructions_UNIT_EDIT_REPAIR();

    // Build a rel->uri map from included files
    const relToUri = new Map<string, string>();
    for (const f of (params.c0.files ?? []) as any[]) {
      const rel = normalizeRel(String(f?.rel ?? ""));
      const uri = String(f?.uri ?? "");
      if (rel && uri) relToUri.set(rel, uri);
    }

    // Group edits by file, preserving original order via original array index
    type IndexedUnit = { idx: number; unit: UnitChange };

    const groups = new Map<string, IndexedUnit[]>();
    for (let idx = 0; idx < (out.edits?.length ?? 0); idx++) {
      const unit = out.edits[idx];
      const rel = normalizeRel(String(unit?.file ?? ""));
      if (!rel) throw new Error(`[phaseB.5] edit[${idx}] missing file`);
      if (!groups.has(rel)) groups.set(rel, []);
      groups.get(rel)!.push({ idx, unit });
    }
    for (const items of groups.values()) items.sort((a, b) => a.idx - b.idx);

    // Read only the files referenced by edits (once)
    const uniqueRel = Array.from(groups.keys());
    const fileTextByRel = new Map<string, string>();

    await Promise.all(uniqueRel.map(async (rel) => {
      const uri = relToUri.get(rel);
      if (!uri) throw new Error(`[phaseB.5] edit refers to file not in AVAILABLE FILES: ${rel}`);
      const fsPath = vscode.Uri.parse(uri).fsPath;
      const text = await fs.readFile(fsPath, "utf8");
      fileTextByRel.set(rel, text);
    }));

    params.status(
      `phaseB.5 (repair diffs): ${out.edits.length} edit(s) across ${uniqueRel.length} file(s), parallelFiles=${parallelFiles}...`
    );

    // We fill by original index to preserve global order of out.edits
    const repaired: Array<UnitChange | undefined> = new Array(out.edits.length);

    const groupList = uniqueRel.map((rel) => ({ rel, items: groups.get(rel)! }));

    await runPool(groupList, parallelFiles, async ({ rel, items }) => {
      let curText = fileTextByRel.get(rel);
      if (curText == null) throw new Error(`[phaseB.5] missing baseline text for ${rel}`);

      // Process edits for this file sequentially, updating baseline after each success
      for (let j = 0; j < items.length; j++) {
        const { idx, unit } = items[j];

        // Use the current baseline (after previous edits)
        const originalDiff = String(unit?.diff ?? "");
        const originalRationale = String(unit?.rationale ?? "");

        // Fast path: if it applies, accept and advance baseline
        let sim = tryApplyUnifiedDiff({ rel, oldText: curText, diff: originalDiff });
        if (sim.ok) {
          repaired[idx] = { file: rel, diff: originalDiff, rationale: originalRationale };
          curText = String(sim.afterText ?? curText);
          continue;
        }

        // Repair loop: repair must target *current* baseline
        let lastErr = renderUnifiedDiffIssues(sim.issues);
        let cur: UnitChange = { file: rel, diff: originalDiff, rationale: originalRationale };

        const baseHash = hashHex(curText, 10);
        const le = detectDominantLineEnding(curText);
        const { numbered, totalLines, truncated } = formatWithLineNumbers(curText);
        const baselineInfo = `hash=${baseHash}, lines=${totalLines}, lineEnding=${le}, truncated=${truncated}`;

        for (let round = 1; round <= maxRounds; round++) {
          const { input: fixInput, trace_input: fixTrace } = await build_input_UNIT_EDIT_REPAIR({
            targetFile: rel,
            phaseA: params.phaseA,
            unit: cur,
            baselineInfo,
            baselineNumbered: numbered,
            applyError: lastErr,
            attempt: round
          });

          const cand = await params.openai.language_request_with_TAGS_out<UnitChange>({
            modelKind: lightModelKind,
            instructions: repairInstructions,
            input: fixInput,
            schema: UnitChange_TagSchema,
            maxRetries: 1,
            addFormatInstructions: false
          });

          // Hard enforce target file; never allow redirection
          cur = {
            file: rel,
            diff: String(cand?.diff ?? ""),
            rationale: String(cand?.rationale ?? "")
          };

          sim = tryApplyUnifiedDiff({ rel, oldText: curText, diff: cur.diff });
          if (sim.ok) {
            repaired[idx] = cur;
            curText = String(sim.afterText ?? curText);

            params.mode.trace?.addStep?.("phaseB_unit_repair_ok", Date.now(), Date.now(), {
              file: rel,
              idx,
              model: String(lightModelKind),
              baselineInfo,
              input: fixTrace,
              output: { file: cur.file, rationale: cur.rationale, diffChars: cur.diff.length }
            });

            break;
          }

          lastErr = renderUnifiedDiffIssues(sim.issues);
        }

        if (!repaired[idx]) {
          throw new Error(
            `[phaseB.5] Failed to repair diff for ${rel} (edit[${idx}] within fileQueueIndex=${j}) after ${maxRounds} round(s).\nLast error:\n${lastErr}`
          );
        }
      }

      // Keep final in-memory text (not written). Useful later if you want to show a preview.
      fileTextByRel.set(rel, curText);
    });

    // Ensure all repaired
    for (let i = 0; i < repaired.length; i++) {
      if (!repaired[i]) {
        throw new Error(`[phaseB.5] internal error: repaired[${i}] not filled`);
      }
    }

    out.edits = repaired as UnitChange[];

    params.mode.trace?.addStep("phaseB_unit_split", t0, Date.now(), {
      mode: params.mode.kind,
      model: String(modelKind),
      input: trace_input,
      instructions,
      output: {
        summary: out.summary,
        editCount: out.edits.length,
        edits: out.edits,
        notes: out.notes
      }
    });

    return out;
  } catch (e: any) {
    const msg = errMsg(e);
    const stack = (e && typeof e === "object" && "stack" in e) ? String((e as any).stack ?? "") : "";

    // Keep a short human diag
    params.mode.diag?.push(`[phaseB] Edit compile/repair failed: ${msg}`);

    // Put the real thing in trace (msg + stack)
    params.mode.trace?.addEvent?.("phaseB_compile_or_repair_failed", {
      msg,
      stack: stack ? stack.slice(0, 20_000) : undefined,
      causeMsg: e?.cause ? errMsg(e.cause) : undefined
    });

    // Rethrow with cause so upstream wrappers can surface the real error
    throw new Error(`<phaseB_unitChanges> failed: ${ {cause: e} }`);
  }
}
