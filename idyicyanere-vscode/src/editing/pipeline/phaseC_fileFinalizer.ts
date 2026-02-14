import * as vscode from "vscode";
import { promises as fs } from "fs";

import { OpenAIService } from "../../openai/openaiService";
import { PlannerConfig } from "./tools/types";
import { errMsg, normalizeRel, runPool, hashHex } from "./tools/utils";
import { ModeSession } from "./tools/modeSession";

import type {
  ContextZero,
  ChangeDescription,
  UnitSplitOut,
  UnitChange
} from "./prompts";

import {
  UnitChange_TagSchema,
  build_instructions_UNIT_EDIT_REPAIR,
  build_input_UNIT_EDIT_REPAIR,
  build_instructions_FILE_SYNTAX_REPAIR,
  build_input_FILE_SYNTAX_REPAIR
} from "./prompts";

import {
  formatWithLineNumbers,
  tryApplyUnifiedDiff,
  renderUnifiedDiffIssues,
  detectDominantLineEnding,
  type UnifiedDiffIssue
} from "./tools/unitDiff";

// -------- Types returned by Phase C --------

export type SyntaxIssue = {
  severity: "warn" | "error";
  message: string;
  line?: number;   // 1-based
  col?: number;    // 1-based
  code?: string;
};

export type PhaseCFileResult = {
  rel: string;
  uri: string;

  beforeText: string;
  afterText: string;

  // Final list of edits for this file (original + any repairs + optional syntax-fix)
  edits: UnitChange[];

  applyOk: boolean;
  applyIssues: UnifiedDiffIssue[];

  syntaxOk: boolean;
  syntaxIssues: SyntaxIssue[];

  beforeHash: string;
  afterHash: string;
};

export type PhaseCOut = {
  ok: boolean;
  summary: string;
  files: PhaseCFileResult[];

  // Convenience: final texts per file (only touched files)
  mergedFiles: Record<string, string>;
};

// -------- TypeScript syntax checking (optional dependency) --------

// Avoid compile-time dependency; we try runtime require.
declare const require: any;

let _tsCached: any | null | undefined;

function getTypeScript(): any | null {
  if (_tsCached !== undefined) return _tsCached;
  try {
    _tsCached = require("typescript");
  } catch {
    _tsCached = null;
  }
  return _tsCached;
}

function posToLineCol(text: string, pos0: number): { line: number; col: number } {
  const s = String(text ?? "");
  const p = Math.max(0, Math.min(s.length, Math.trunc(pos0)));
  let line = 1;
  let col = 1;

  for (let i = 0; i < p; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 10 /* \n */) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

function checkJsonSyntax(rel: string, text: string): SyntaxIssue[] {
  try {
    JSON.parse(String(text ?? ""));
    return [];
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // Try to extract "position N"
    const m = msg.match(/position\s+(\d+)/i);
    const pos = m ? Number(m[1]) : NaN;
    const lc = Number.isFinite(pos) ? posToLineCol(text, pos) : null;

    return [{
      severity: "error",
      code: "json_parse_error",
      message: `JSON parse error: ${msg}`,
      line: lc?.line,
      col: lc?.col
    }];
  }
}

function checkTsJsSyntax(rel: string, text: string): SyntaxIssue[] {
  const ts = getTypeScript();
  if (!ts) {
    return [{
      severity: "warn",
      code: "ts_unavailable",
      message: "TypeScript module not available at runtime; skipping TS/JS syntax validation."
    }];
  }

  const fileName = String(rel ?? "file.ts");
  const lower = fileName.toLowerCase();

  const kind =
    lower.endsWith(".tsx") ? ts.ScriptKind.TSX :
    lower.endsWith(".jsx") ? ts.ScriptKind.JSX :
    lower.endsWith(".js")  ? ts.ScriptKind.JS :
    lower.endsWith(".cjs") ? ts.ScriptKind.JS :
    lower.endsWith(".mjs") ? ts.ScriptKind.JS :
    ts.ScriptKind.TS;

  const sf = ts.createSourceFile(
    fileName,
    String(text ?? ""),
    ts.ScriptTarget.Latest,
    true,
    kind
  );

  const diags = Array.isArray(sf?.parseDiagnostics) ? sf.parseDiagnostics : [];
  if (!diags.length) return [];

  const out: SyntaxIssue[] = [];
  for (const d of diags.slice(0, 50)) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    const start = typeof d.start === "number" ? d.start : 0;
    const lc = sf.getLineAndCharacterOfPosition(start);

    out.push({
      severity: "error",
      code: `ts_${String(d.code ?? "parse")}`,
      message: String(msg ?? "").trim(),
      line: (lc?.line ?? 0) + 1,
      col: (lc?.character ?? 0) + 1
    });
  }

  return out;
}

function checkSyntax(rel: string, text: string): SyntaxIssue[] {
  const lower = String(rel ?? "").toLowerCase();
  if (lower.endsWith(".json")) return checkJsonSyntax(rel, text);

  // TS/JS family
  if (
    lower.endsWith(".ts") || lower.endsWith(".tsx") ||
    lower.endsWith(".js") || lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") || lower.endsWith(".cjs")
  ) {
    return checkTsJsSyntax(rel, text);
  }

  // Unknown/unsupported -> no issues
  return [];
}

function countSyntaxErrors(issues: SyntaxIssue[]): number {
  return (issues ?? []).filter((x) => x.severity === "error").length;
}

function renderSyntaxIssuesForPrompt(issues: SyntaxIssue[]): string {
  const xs = (issues ?? []).slice(0, 20);
  return xs.map((x, i) => {
    const loc =
      x.line != null
        ? `:${x.line}${x.col != null ? `:${x.col}` : ""}`
        : "";
    return `#${i + 1} ${x.severity.toUpperCase()} ${x.code ?? ""} ${loc} ${x.message}`.trim();
  }).join("\n");
}

// -------- File reading / grouping --------

function buildRelToUri(files: any[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files ?? []) {
    const rel = normalizeRel(String(f?.rel ?? ""));
    const uri = String(f?.uri ?? "");
    if (rel && uri) m.set(rel, uri);
  }
  return m;
}

async function readFileText(uri: string): Promise<string> {
  const fsPath = vscode.Uri.parse(uri).fsPath;
  return await fs.readFile(fsPath, "utf8");
}

type IndexedEdit = { idx: number; unit: UnitChange };

function groupEditsByFile(edits: UnitChange[]): Array<{ rel: string; items: IndexedEdit[] }> {
  const by = new Map<string, IndexedEdit[]>();

  for (let i = 0; i < (edits ?? []).length; i++) {
    const unit = edits[i];
    const rel = normalizeRel(String(unit?.file ?? ""));
    if (!rel) continue;
    if (!by.has(rel)) by.set(rel, []);
    by.get(rel)!.push({ idx: i, unit });
  }

  const out = Array.from(by.entries())
    .map(([rel, items]) => ({
      rel,
      items: items.sort((a, b) => a.idx - b.idx)
    }))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  return out;
}

// -------- Phase C main --------

export async function finalizeFiles(params: {
  c0: ContextZero;
  phaseA: ChangeDescription;
  phaseB: UnitSplitOut;

  mode: ModeSession;
  cfg: PlannerConfig;

  openai: OpenAIService;
  status: (s: string) => void;
}): Promise<PhaseCOut> {
  const t0 = Date.now();

  const edits = Array.isArray(params.phaseB?.edits) ? params.phaseB.edits : [];
  const groups = groupEditsByFile(edits);

  if (!groups.length) {
    return {
      ok: true,
      summary: "No edits; nothing to finalize.",
      files: [],
      mergedFiles: {}
    };
  }

  const relToUri = buildRelToUri((params.c0.files ?? []) as any[]);
  const touchedRels = groups.map((g) => g.rel);

  // Read all touched files once
  const beforeByRel = new Map<string, string>();
  await Promise.all(touchedRels.map(async (rel) => {
    const uri = relToUri.get(rel);
    if (!uri) throw new Error(`[phaseC] edit refers to file not in AVAILABLE FILES: ${rel}`);
    beforeByRel.set(rel, await readFileText(uri));
  }));

  // Concurrency per file
  const parallelFiles = Math.max(1, Math.min(32, params.cfg.parallel?.files ?? 4));

  // Repair knobs
  const diffRepairRounds = Math.max(1, Math.min(6, params.cfg.attempts?.maxRounds ?? 3));
  const syntaxRepairRounds = 2; // bounded; only triggers if syntax errors exist

  const diffRepairInstr = await build_instructions_UNIT_EDIT_REPAIR();
  const syntaxRepairInstr = await build_instructions_FILE_SYNTAX_REPAIR();

  params.status(
    `phaseC (finalize): ${edits.length} edit(s) across ${groups.length} file(s), parallelFiles=${parallelFiles}...`
  );

  const fileResults: PhaseCFileResult[] = new Array(groups.length);
  const mergedFiles: Record<string, string> = {};

  await runPool(groups, parallelFiles, async (g, gi) => {
    const rel = g.rel;
    const uri = relToUri.get(rel);
    if (!uri) throw new Error(`[phaseC] missing uri for ${rel}`);

    const beforeText = beforeByRel.get(rel);
    if (beforeText == null) throw new Error(`[phaseC] missing baseline text for ${rel}`);

    let curText = beforeText;
    const outEdits: UnitChange[] = [];

    let applyOk = true;
    let applyIssues: UnifiedDiffIssue[] = [];

    // --- Apply edits sequentially for this file, repairing diffs if needed ---
    for (let j = 0; j < g.items.length; j++) {
      const { idx, unit } = g.items[j];

      let cand: UnitChange = {
        file: rel,
        diff: String(unit?.diff ?? ""),
        rationale: String(unit?.rationale ?? "")
      };

      let sim = tryApplyUnifiedDiff({ rel, oldText: curText, diff: cand.diff });
      if (sim.ok) {
        curText = String(sim.afterText ?? curText);
        outEdits.push(cand);
        continue;
      }

      // Attempt repair against *current* baseline (this is the key incremental-safety point)
      let lastErr = renderUnifiedDiffIssues(sim.issues);

      const le = detectDominantLineEnding(curText);
      const baseHash = hashHex(curText, 10);
      const { numbered, totalLines, truncated } = formatWithLineNumbers(curText);
      const baselineInfo = `hash=${baseHash}, lines=${totalLines}, lineEnding=${le}, truncated=${truncated}`;

      let repairedOk = false;

      for (let round = 1; round <= diffRepairRounds; round++) {
        const { input: fixInput, trace_input: fixTrace } = await build_input_UNIT_EDIT_REPAIR({
          targetFile: rel,
          phaseA: params.phaseA,
          unit: cand,
          baselineInfo,
          baselineNumbered: numbered,
          applyError: lastErr,
          attempt: round
        });

        const modelOut = await params.openai.language_request_with_TAGS_out<UnitChange>({
          modelKind: "light",
          instructions: diffRepairInstr,
          input: fixInput,
          schema: UnitChange_TagSchema,
          maxRetries: 1,
          addFormatInstructions: false
        });

        cand = {
          file: rel, // enforce
          diff: String(modelOut?.diff ?? ""),
          rationale: String(modelOut?.rationale ?? "")
        };

        sim = tryApplyUnifiedDiff({ rel, oldText: curText, diff: cand.diff });
        if (sim.ok) {
          repairedOk = true;
          curText = String(sim.afterText ?? curText);
          outEdits.push(cand);

          params.mode.trace?.addStep?.("phaseC_unit_repair_ok", Date.now(), Date.now(), {
            rel,
            editIndex: idx,
            fileQueueIndex: j,
            baselineInfo,
            input: fixTrace,
            output: { diffChars: cand.diff.length, rationale: cand.rationale }
          });

          break;
        }

        lastErr = renderUnifiedDiffIssues(sim.issues);
      }

      if (!repairedOk) {
        applyOk = false;
        applyIssues = sim.issues ?? [];
        params.mode.trace?.addEvent?.("phaseC_apply_failed", {
          rel,
          editIndex: idx,
          fileQueueIndex: j,
          lastErr
        });
        break;
      }
    }

    // --- Syntax validation (deterministic) ---
    let syntaxIssues = checkSyntax(rel, curText);
    let syntaxOk = countSyntaxErrors(syntaxIssues) === 0;

    // --- Optional: bounded syntax repair (light model) ---
    if (applyOk && !syntaxOk) {
      let lastApplyErr: string | undefined = undefined;

      for (let round = 1; round <= syntaxRepairRounds; round++) {
        const prevErrCount = countSyntaxErrors(syntaxIssues);
        if (prevErrCount === 0) { syntaxOk = true; break; }

        const le = detectDominantLineEnding(curText);
        const baseHash = hashHex(curText, 10);
        const { numbered, totalLines, truncated } = formatWithLineNumbers(curText);
        const baselineInfo = `hash=${baseHash}, lines=${totalLines}, lineEnding=${le}, truncated=${truncated}`;

        const { input: fixInput, trace_input: fixTrace } = await build_input_FILE_SYNTAX_REPAIR({
          targetFile: rel,
          phaseA: params.phaseA,
          appliedEdits: outEdits,
          baselineInfo,
          baselineNumbered: numbered,
          syntaxErrors: renderSyntaxIssuesForPrompt(syntaxIssues),
          applyError: lastApplyErr,
          attempt: round
        });

        const modelOut = await params.openai.language_request_with_TAGS_out<UnitChange>({
          modelKind: "light",
          instructions: syntaxRepairInstr,
          input: fixInput,
          schema: UnitChange_TagSchema,
          maxRetries: 1,
          addFormatInstructions: false
        });

        const fixEdit: UnitChange = {
          file: rel, // enforce
          diff: String(modelOut?.diff ?? ""),
          rationale: String(modelOut?.rationale ?? "")
        };

        if (!fixEdit.diff.trim()) {
          // Model gave up: stop attempts
          params.mode.trace?.addEvent?.("phaseC_syntax_fix_empty", {
            rel,
            attempt: round,
            input: fixTrace,
            rationale: fixEdit.rationale
          });
          break;
        }

        const sim = tryApplyUnifiedDiff({ rel, oldText: curText, diff: fixEdit.diff });
        if (!sim.ok) {
          lastApplyErr = renderUnifiedDiffIssues(sim.issues);
          params.mode.trace?.addEvent?.("phaseC_syntax_fix_apply_failed", {
            rel,
            attempt: round,
            lastApplyErr
          });
          continue;
        }

        const nextText = String(sim.afterText ?? curText);
        const nextIssues = checkSyntax(rel, nextText);

        const nextErrCount = countSyntaxErrors(nextIssues);

        // Accept only if it actually reduces syntax errors.
        if (nextErrCount < prevErrCount) {
          curText = nextText;
          outEdits.push({
            file: rel,
            diff: fixEdit.diff,
            rationale: fixEdit.rationale ? `syntax-fix: ${fixEdit.rationale}` : "syntax-fix"
          });

          syntaxIssues = nextIssues;
          syntaxOk = nextErrCount === 0;

          params.mode.trace?.addStep?.("phaseC_syntax_fix_ok", Date.now(), Date.now(), {
            rel,
            attempt: round,
            prevErrCount,
            nextErrCount,
            input: fixTrace,
            output: { diffChars: fixEdit.diff.length }
          });

          if (syntaxOk) break;
        } else {
          // Patch applied but did not improve -> reject it (keep curText)
          params.mode.trace?.addEvent?.("phaseC_syntax_fix_no_improvement", {
            rel,
            attempt: round,
            prevErrCount,
            nextErrCount
          });
          break;
        }
      }
    }

    const beforeHash = hashHex(beforeText, 10);
    const afterHash = hashHex(curText, 10);

    const fr: PhaseCFileResult = {
      rel,
      uri,
      beforeText,
      afterText: curText,
      edits: outEdits,

      applyOk,
      applyIssues,

      syntaxOk,
      syntaxIssues,

      beforeHash,
      afterHash
    };

    fileResults[gi] = fr;
    mergedFiles[rel] = curText;
  });

  const ok =
    fileResults.every((f) => f && f.applyOk) &&
    fileResults.every((f) => f && f.syntaxOk);

  const badApply = fileResults.filter((f) => f && !f.applyOk).length;
  const badSyntax = fileResults.filter((f) => f && !f.syntaxOk).length;

  const summary =
    `finalized files=${fileResults.length}, applyFailures=${badApply}, syntaxFailures=${badSyntax}, ok=${ok}`;

  params.mode.trace?.addStep?.("phaseC_finalize_done", t0, Date.now(), {
    summary,
    ok,
    files: fileResults.map((f) => ({
      rel: f.rel,
      applyOk: f.applyOk,
      syntaxOk: f.syntaxOk,
      beforeHash: f.beforeHash,
      afterHash: f.afterHash,
      editCount: f.edits.length,
      syntaxErrCount: countSyntaxErrors(f.syntaxIssues)
    }))
  });

  return {
    ok,
    summary,
    files: fileResults,
    mergedFiles
  };
}
