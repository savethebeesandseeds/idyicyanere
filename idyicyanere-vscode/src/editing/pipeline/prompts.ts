import { buildFilesContext } from "./tools/utils";
import type { IncludedFile } from "./tools/types";
import type { TaggedSchema } from "../../openai/utils";

export type ContextZero = {
  prompt: string;
  files: IncludedFile[];
};
export const ChangeDescription_schemaKeys = ["plan", "notes"] as const;
/*
 *  --------- Phase A ---------
 */
export type ChangeDescription = {
  plan: string;
  notes: string;
};

export async function build_input_CHANGE_DESCRIPTION(
  c0: ContextZero
): Promise<{ input: string; trace_input: string; }> {
  const { filesList, filesContent } = await buildFilesContext(c0.files);
  
  const trace_input = [
    "...REQUEST BEGINS...",
    "REQUEST CLARIFICATIONS:",
    ' "PROMPT": string, the user given request.',
    ' "CONTEXT": comma separated list of files, followed by their contents.',
    '',
    "PROMPT:",
    c0.prompt,
    '',
    "AVAILABLE FILES:",
    `[${filesList.map((x) => JSON.stringify(x)).join(", ")}]`,
    "CONTEXT:",
    '',
    '__FILES_CONTENTS__',
    "...REQUEST ENDS..."
  ].join("\n");
  const input = trace_input.replace("__FILES_CONTENTS__", filesContent);
  return { input, trace_input };
}

export async function build_instructions_CHANGE_DESCRIPTION(
  c0: ContextZero
): Promise<string> {
  return [
    "...INSTRUCTION BEGINS...",
    "ROLE: Precise change specification module.",
    "GOAL: Convert the REQUEST into a specific, implementation-ready change description for downstream automation.",
    "",
    "SCHEMA (HARD): Output ONLY this shape, nothing else (no markdown/code fences; no text outside tags):",
    "<plan>...</plan>",
    "<notes>...</notes>",
    "",
    "OUTPUT CLARIFICATIONS:",
    "- Write the full change specification inside <plan> (later stages rely on it).",
    "- Use <notes> (optional) if empty just <notes></notes>.",
    "",
    "GUIDELINES:",
    "- SCOPE (HARD): Only describe changes within the provided AVAILABLE FILES list.",
    "- Use a per-file structure. Always name the file (relative path) for each change.",
    "- Be explicit and concrete. Avoid abstract advice.",
    "- For each change, include copy/paste-ready NEW text when applicable (exact code to insert/replace).",
    "- If you reference existing code, quote short identifying snippets (so later steps can anchor).",
    "- Cover every required change even if repeated across files/locations.",
    "",
    "RULES:",
    "- Specify every change as a DIFF-LIKE PATCH per file (---/+++ headers, @@ blocks, with +/- lines).",
    "- MAY omit line ranges in @@ headers (you may use bare '@@' as a section marker).",
    "- DO NOT use '...' anywhere inside patches. Use real context lines instead (copied from the provided file snippets).",
    "- Each patch must include at least 2 unchanged context lines before and after the changed lines (lines starting with a single space).",
    "...INSTRUCTION ENDS..."
  ].join("\n");
}

/*
 *  --------- Phase B ---------
 */

export type UnitChange = {
  file: string;
  diff: string;
  rationale: string;
};

export type UnitSplitOut = {
  summary: string;
  edits: UnitChange[];
  notes: string;
};

export const UnitChange_TagSchema: TaggedSchema<UnitChange> = {
  kind: "object",
  order: ["file", "diff", "rationale"],
  fields: {
    file: { kind: "string", trim: true },
    // Preserve diff EXACTLY (no .trim()) and encourage CDATA in format rendering
    diff: { kind: "string", trim: false, cdata: true },
    rationale: { kind: "string", trim: true }
  }
};

export const UnitSplitOut_TagSchema: TaggedSchema<UnitSplitOut> = {
  kind: "object",
  order: ["summary", "edits", "notes"],
  enforceOnlyTags: true,
  fields: {
    summary: { kind: "string", trim: true },
    edits: {
      kind: "array",
      itemTag: "edit",
      item: UnitChange_TagSchema,
      enforceOnlyItems: true
    },
    notes: { kind: "string", trim: true }
  }
};

export async function build_input_UNIT_SPLIT(
  c0: ContextZero, 
  phaseA: ChangeDescription
): Promise<{ input: string; trace_input: string; }> {
  const { filesList, filesContent } = await buildFilesContext(c0.files);
  
  const trace_input = [
    "...REQUEST BEGINS...",
    "REQUEST CLARIFICATIONS:",
    ' "PROMPT": contains the full change description; compile it into exact edit operations.',
    ' "CONTEXT": list of files, followed by their contents.',
    ' "NOTES": optional notes from Phase A.',
    '',
    "PROMPT:",
    phaseA.plan,
    '',
    "CONTEXT:",
    `"files_list": [${filesList.map((x) => JSON.stringify(x)).join(", ")}]`,
    '',
    '__FILES_CONTENTS__',
    "NOTES:",
    JSON.stringify(phaseA.notes ?? [], null, 2),
    "...REQUEST ENDS..."
  ].join("\n");

  const input = trace_input.replace("__FILES_CONTENTS__", filesContent);
  return { input, trace_input };
}

export async function build_instructions_UNIT_SPLIT(
  c0: ContextZero, 
  phaseA: ChangeDescription
) : Promise<string> {
  return [
    "...INSTRUCTION BEGINS...",
    "ROLE: Change-to-Edits compiler for an automated code editor.",
    "GOAL: Convert the PROMPT (change description) into exact, machine-actionable edit operations.",
    "",
    "YOU ARE GIVEN:",
    "- IMPORTANT: patches may be diff-like and may omit @@ line ranges; your job is to compile them into a VALID unified diff that applies to the provided file contents.",
    "- PROMPT: the change description (Phase A output).",
    "- AVAILABLE FILES list.",
    "- File contents for those files.",
    "",
    "OUTPUT FORMAT (STRICT): return ONLY these tags, in this exact order. No extra text, no markdown fences.",
    "",
    "<summary>...</summary>",
    "<edits>",
    "  <edit>",
    "    <file>...</file>",
    "    <diff>...</diff>",
    "    <rationale>...</rationale>",
    "  </edit>",
    "  <!-- repeat <edit>...</edit> blocks as needed -->",
    "</edits>",
    "<notes>...</notes>",
    "",
    "OUTPUT CLARIFICATIONS:",
    "- Output ONLY the tags shown above. Do not add other tags.",
    "- Inside <edits>, you may output ZERO or more <edit> blocks.",
    "- Each <edit> MUST include exactly one <file>, one <diff>, one <rationale>.",
    "- <file> MUST match one of AVAILABLE FILES exactly.",
    "- <diff> MUST be a unified diff (unidiff) that applies to that single file.",
    "- <diff> MUST NOT include changes for multiple files. One <edit> == one file.",
    "- <rationale> should be short and concrete (use empty string if unnecessary).",
    "- If there are no edits, output: <edits></edits>.",
    "- If there are no notes, output: <notes></notes>.",
    "",
    "HARD RULES:",
    "1) SCOPE: Only modify files that appear in AVAILABLE FILES.",
    "2) VERBATIM / CONTEXT SAFETY:",
    "   - All context lines in the diff MUST be copied EXACTLY from the provided file contents.",
    "   - Placeholders like '...' or does not provide real context, REPLACE those placeholders and use the actual file contents to construct safe hunks.",
    "   - Do NOT invent surrounding lines. If you cannot find stable context in the provided text, DO NOT guess.",
    "3) NO GUESSING:",
    "   - If you cannot produce an exact diff that matches the provided file contents, skip that edit.",
    "   - Instead: add a note explaining what is missing and what exact text you expected to find.",
    "4) DIFF FORMAT (HARD):",
    "   - Use standard unified diff hunks with @@ headers.",
    "   - Keep hunks small and local (minimal context that is still safe).",
    "   - Every @@ hunk header MUST include real line ranges: '@@ -l,s +l,s @@'. (Do not output bare '@@'.)",
    "   - Every removal line must start with '-' and every addition line with '+'. Unchanged context lines start with ' '.",
    "5) PRECISION:",
    "   - Prefer small, local diffs over rewriting large blocks.",
    "6) ORDERING (IMPORTANT):",
    "   - For multiple edits in the same file, output them in a safe application order (typically bottom-to-top if independent).",
    "7) COMPLETENESS:",
    "   - Cover every required change even if repeated in multiple files/locations.",
    "",
    "QUALITY BAR:",
    "- Your output must be directly usable by a program that applies unified diffs to the specified file.",
    "",
    "...INSTRUCTION ENDS..."
  ].join("\n");
}

/*
 * -------- Phase B.5 (Repair / Correct per UnitChange) --------
 */

export async function build_instructions_UNIT_EDIT_REPAIR(): Promise<string> {
  return [
    "...INSTRUCTION BEGINS...",
    "ROLE: Unified-diff corrector for an automated code editor.",
    "GOAL: Fix CURRENT DIFF ATTEMPT so it applies cleanly to the BASELINE FILE CONTENT and still implements the intended unit change.",
    "",
    "YOU ARE GIVEN:",
    "- TARGET FILE path.",
    "- BASELINE FILE CONTENT (with line numbers; prefixes like '0001|' are NOT part of file content).",
    "- CURRENT DIFF ATTEMPT (may be invalid / not applying).",
    "- APPLY ERROR from the previous attempt (if any).",
    "",
    "OUTPUT FORMAT (STRICT): return ONLY these tags, in this exact order. No extra text, no markdown fences.",
    "<file>...</file>",
    "<diff><![CDATA[...]]></diff>",
    "<rationale>...</rationale>",
    "",
    "HARD RULES:",
    "1) <file> MUST exactly equal TARGET FILE.",
    "2) <diff> MUST be a unified diff that applies to ONLY that file.",
    "   - Include --- / +++ headers and @@ hunks.",
    "   - Use exact context lines from the baseline file (do NOT include the line-number prefixes).",
    "3) Keep edits minimal and local.",
    "4) Always wrap the diff in CDATA. The CDATA content must start directly with '---' (no leading blank line).",
    "5) If you truly cannot produce an applying diff, output <diff></diff> and explain precisely why in <rationale>.",
    "6) If APPLY ERROR mentions 'bad_hunk_header' or 'no_hunks', the diff is not valid unidiff.",
    "   - Fix by producing proper hunk headers with ranges: '@@ -l,s +l,s @@'.",
    "   - Use the BASELINE LINE NUMBERS to compute l and s (do NOT guess).",
    "",
    "...INSTRUCTION ENDS..."
  ].join("\n");
}

export async function build_input_UNIT_EDIT_REPAIR(params: {
  targetFile: string;
  phaseA: ChangeDescription;
  unit: UnitChange;
  baselineInfo: string;           // e.g. "hash=..., lines=..., lineEnding=..."
  baselineNumbered: string;       // full (or truncated) numbered baseline text
  applyError?: string;            // from simulation
  attempt: number;                // 1-based repair attempt
}): Promise<{ input: string; trace_input: string }> {
  const trace_input = [
    "...REQUEST BEGINS...",
    "REQUEST CLARIFICATIONS:",
    "- Correct the DIFF so it applies cleanly to the baseline file.",
    "- The baseline file is authoritative. Do not guess context.",
    "",
    `TARGET FILE: ${params.targetFile}`,
    `BASELINE INFO: ${params.baselineInfo}`,
    `REPAIR ATTEMPT: ${params.attempt}`,
    "",
    "INTENDED UNIT RATIONALE (from compiler):",
    params.unit.rationale ?? "",
    "",
    "PHASE A PLAN (for intent, may include other files):",
    params.phaseA.plan ?? "",
    "",
    "CURRENT DIFF ATTEMPT:",
    params.unit.diff ?? "",
    "",
    ...(params.applyError ? ["APPLY ERROR:", params.applyError, ""] : []),
    "BASELINE FILE CONTENT (LINE-NUMBERED; prefix is NOT part of file):",
    params.baselineNumbered,
    "",
    "...REQUEST ENDS..."
  ].join("\n");

  // input is short enough to equal trace_input
  return { input: trace_input, trace_input };
}

/*
 *  --------- Phase C ---------
 *  --------- (Apply) ---------
 *  light-model fix for syntax errors
 */
export async function build_instructions_FILE_SYNTAX_REPAIR(): Promise<string> {
  return [
    "...INSTRUCTION BEGINS...",
    "ROLE: Syntax-fix patch author for an automated code editor.",
    "GOAL: Produce a MINIMAL unified diff that fixes the listed SYNTAX ERRORS in the BASELINE FILE CONTENT.",
    "",
    "YOU ARE GIVEN:",
    "- TARGET FILE path.",
    "- BASELINE FILE CONTENT with line numbers (prefix like '0001|' is NOT part of file).",
    "- SYNTAX ERRORS (line/col + message).",
    "- APPLIED EDITS context (so you don't undo changes).",
    "",
    "OUTPUT FORMAT (STRICT): return ONLY these tags, in this exact order. No extra text, no markdown fences.",
    "<file>...</file>",
    "<diff><![CDATA[...]]></diff>",
    "<rationale>...</rationale>",
    "",
    "HARD RULES:",
    "1) <file> MUST exactly equal TARGET FILE.",
    "2) <diff> MUST be a unified diff that applies to ONLY that file.",
    "   - Include --- / +++ headers and @@ hunks.",
    "   - Use exact context lines from the baseline file (do NOT include the line-number prefixes).",
    "3) Fix ONLY syntax/parse errors. Do not refactor. Do not change unrelated logic.",
    "4) Keep patch minimal and local.",
    "5) Always wrap the diff in CDATA. The CDATA content must start directly with '---' (no leading blank line).",
    "6) If you truly cannot fix, output <diff></diff> and explain why in <rationale>.",
    "7) HUNK HEADERS (HARD): Never output bare '@@'. Every hunk header must be '@@ -<int>,<int> +<int>,<int> @@'.",
    "",
    "...INSTRUCTION ENDS..."
  ].join("\n");
}

export async function build_input_FILE_SYNTAX_REPAIR(params: {
  targetFile: string;
  phaseA: ChangeDescription;
  appliedEdits: UnitChange[];       // edits already applied to reach baseline
  baselineInfo: string;
  baselineNumbered: string;
  syntaxErrors: string;
  applyError?: string;
  attempt: number;
}): Promise<{ input: string; trace_input: string }> {
  const recent = (params.appliedEdits ?? []).slice(-3);

  const trace_input = [
    "...REQUEST BEGINS...",
    "REQUEST CLARIFICATIONS:",
    "- Fix syntax errors in the current file state.",
    "- Do not undo intended edits; only repair syntax/parse problems.",
    "",
    `TARGET FILE: ${params.targetFile}`,
    `BASELINE INFO: ${params.baselineInfo}`,
    `SYNTAX FIX ATTEMPT: ${params.attempt}`,
    "",
    "PHASE A PLAN (intent; do NOT re-plan, only syntax-fix):",
    params.phaseA.plan ?? "",
    "",
    "APPLIED EDITS (most recent; do not undo):",
    ...recent.map((e, i) => [
      `--- appliedEdit[${i}] rationale: ${String(e?.rationale ?? "").trim()}`,
      String(e?.diff ?? "").slice(0, 1600) // small head only
    ].join("\n")),
    "",
    "SYNTAX ERRORS:",
    params.syntaxErrors,
    "",
    ...(params.applyError ? ["PREVIOUS PATCH APPLY ERROR:", params.applyError, ""] : []),
    "BASELINE FILE CONTENT (LINE-NUMBERED; prefix is NOT part of file):",
    params.baselineNumbered,
    "",
    "...REQUEST ENDS..."
  ].join("\n");

  return { input: trace_input, trace_input };
}
