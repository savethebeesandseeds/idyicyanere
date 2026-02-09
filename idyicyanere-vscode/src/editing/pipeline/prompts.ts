import { buildFilesContext } from "./tools/utils";
/*
 *  --------- Phase A ---------
 */, 
export async function build_input_CHANGE_DESCRIPTION(params: {
  prompt: string;
  files: Array<{ rel: string; uri: string }>;
}): Promise<string> {
  const { filesList, filesContent } = await buildFilesContext(params.files);
  
  return [
    "...REQUEST BEGINS...",
    "REQUEST CLARIFICATIONS:",
    ' "files_list": string[], comma separated list of files, followed by the contents.',
    ' "prompt": string, the user given request.',
    "",
    "CONTENTS:",
    `"files_list": [${filesList.join(", ")}]`,
    "",
    filesContent,
    "",
    "PROMPT:",
    params.prompt,
    "...REQUEST ENDS..."
  ].join("\n");
}

export type ChangeDescription = {
  result: string;
  assumptions?: string[];
  notes?: string[];
};

export async function build_instructions_CHANGE_DESCRIPTION(params: {}) : Promise<string> {
 return [
    "...INSTRUCTION BEGINS...",
    "ROLE: Change specification module.",
    "GOAL: Convert the REQUEST into a very specific change description for a downstream automated editor.",
    "",
    "OUTPUT schema (STRICT):",
    "{",
    '  "result": string,',
    '  "assumptions"?: string[],',
    '  "notes"?: string[],',
    "}",
    "",
    "OUTPUT CLARIFICATIONS:",
    " Write the whole change specification in result.",
    " If any, REQUEST's instruction ambiguousity, record it in assumptions[] (optional).",
    " Use notes[] (optional) to forward notes down the module's pipeline.",
    "",
    "GUIDELINES:",
    " SCOPE (HARD): Only plan changes within the provided AVAILABLE FILES list.",
    " The result is bound to follow the REQUEST instruction.",
    " Write short sentences (imperative) in a sensible order.",
    " BE PREVISE; explicit in naming the files (use relative paths).",
    " BE PRECISE; avoid abstract instructions.",
    " BE PRECISE; reference every change even if it occurs multiple times.",
    "",
    "kindly, ",
    " Procure a result that can later be split into unified format diff language.",
    "",
    "...INSTRUCTION ENDS...",
  ].join("\n");
}


/*
 *  --------- Phase B ---------
 */

export type UnitChange = {
  file: string;
  domain: string;
  instruction: string;
  notes?: string[];
};

export type UnitSplitOut = {
  summary: string;
  units: UnitChange[];
};

export const PROMPT_UNIT_SPLIT = [
  "ROLE: Split module.",
  "GOAL: Decompose the change request into small, atomic Unit Changes suitable for fragment-based editing.",
  "",
  "CONTEXT:",
  "- The downstream editor edits files in units.",
  "",
  "OUTPUT:, (STRICT) JSON with schema:",
  "{",
  '  "summary": string,',
  '  "units": [',
  "    {",
  '      "file": string,',
  '      "domain": string,',
  '      "instruction": string,',
  '      "notes"?: string[]',
  "    }",
  "  ]",
  "}",
  "",
  "CLARIFICATIONS:",
  " A unit is a small independent change.",
  " \"file\" is the target file.",
  " \"domain\" is the target area of effect (inside file).",
  " \"domain\" must exactly match the current file area of effect.",
  " \"notes\" (optional) caution/helpful notes.",
  " Use \"notes\" to include domain's missing context information, e.g. type and function parameters, and forward REQUEST notes that apply to the unit.",
  "",
  "RULES:",
  " IMPORTANT! \"instruction\"  should describe the required change (assume the REQUEST to be correct and sound).",
  " DO NOT question the REQUST, just split the REQUEST into units.",
  " DO NOT add unespecified changes.",
  " Specify instructions in unified format diff language.",
  " Domain has to be present in file.",
  " When using unified format diff DO NOT include line numbers.",
  "",
].join("\n");

/*
 *  --------- Phase C ---------
 */
export type UnitDiff = {
  file?: string,  // not expected in the model's output, manually added with logic
  domain: string,
  diff: string,
  result: string,
};

export const PROMPT_UNIT_CHANGE = [
  "ROLE: Follow instructions.",
  "GOAL: Execute the .",
  "",
  "OUTPUT, (STRICT) JSON with schema:",
  "{",
  '  "domain": string,',
  '  "diff": string,',
  '  "result": string',
  "}",
  "",
  "CLARIFICATIONS:",
  " You have received a single unit of change.",
  " \"domain\" should be exactly the \"domain\" in the REQUEST, it refers to the region of a file where the change is located (current state).",
  " \"diff\" is unified format diff that precisly describes the RESQUEST solicited change.",
  " \"result\" is the \"domain\" modified by the \"diff\" (final state).",
  "",
  "RULES:",
  " DO NOT reason beyond the explicit instruction.",
  " DO NOT make asumptions beyond the explicit instruction and notes.",
  ""
].join("\n");

export type UnitDiffIssue = {
  severity: "warn" | "error",
  description: string
}
export type UnitValidation = { 
  approve: boolean,
  issues?: UnitDiffIssue[]
}

export const PROMPT_UNIT_VALIDATION = [
  "ROLE: Unit change validator at the final stage",
  "GOAL: Validate correctness without asumptions.",
  "",
  "OUTPUT, (STRICT) JSON with schema:",
  "{",
  '  "approve": boolean,',
  '  "issues"?: [',
  "    {",
  '      "severity": "warn" | "error",',
  '      "description": string',
  "    }",
  "  ]",
  "}",
  "",
  "CLARIFICATIONS:",
  " \"approve\" (required) determine is the change suffices the REQUEST.",
  " \"issues\" (optional). Prefer \"warn\", \"error\" only when \"approve\" is set to false.",
  " \"domain\" should be exactly the \"domain\" in the REQUEST, it refers to the region of a file where the change is located (current state).",
  " \"diff\" is unified format diff that describes the RESQUEST solicited change.",
  " \"result\" is the \"domain\" modified by the \"diff\" (final state).",
  "",
  "Guidelines:",
  " \"approve\": false, if correctness is obviously broken.",
  " \"approve\": false, if diff references things outside the REQUST's \"domain\".",
  " \"approve\": false, if the \"domain\" applied the \"diff\" does not produces the \"result\".",
  " \"approve\": false, if REQUEST instruction is impossible.",
  " \"approve\": true, the change is correct.",
  "RULES:",
  " Simply state DO NOT reason to recomend a solution.",
  " DO NOT go outside the \"domain\" or socope of the change.",
  "",
  " EDIT CONTRACT (STRICT):"
  " You will be provided a code FRAGMENT plus read-only surrounding context."
  " Modify ONLY the fragment. Treat surrounding context as immutable reference."
  " Make the smallest change that satisfies UNIT_JSON.instructions."
  " Do NOT introduce unrelated refactors, renames, reformatting, or style-only changes."
  " Preserve indentation, whitespace conventions, and line endings unless the request explicitly asks for formatting."
  " Do not add placeholders, TODOs, or commented-out code unless explicitly required by the unit."
  " If you cannot confidently implement the unit within the fragment WITHOUT GUESSING about unseen code, output the fragment EXACTLY unchanged."
  " Output MUST be ONLY the updated fragment text. No markdown, no explanations, no headings."
].join("\n");
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
  blocks.push("");
  blocks.push("");
  blocks.push("");
  blocks.push("");
  blocks.push("");
  blocks.push("");
  blocks.push("");
  blocks.push("");
  blocks.push("");

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

/*
 *  --------- Phase D ---------
 */

export const PROMPT_FILE_VALIDATE = [
  "Role: Final per-file validator for a code fragments editions.",
  "Goal: Confirm the final file result satisfies ALL unit changes listed for that file.",
  "",
  "Output format (STRICT): return ONLY valid JSON with this schema:",
  "{",
  '  "summary": string,',
  '  "issues": [',
  "    {",
  '      "severity": "warn" | "error",',
  '      "rel"?: string,',
  '      "message": string,',
  '      "suggestion"?: string',
  "    }",
  "  ]",
  "}",
  "",
  "Checklist:",
  "- DUPLICATION: Are there duplicate imports, functions, or variable declarations caused by merging fragments?",
  "- SYNTAX: Is the final file syntactically valid",
  "- COMPLETENESS: Were all assigned units for this file addressed?",
  "Guidelines:",
  "- ERROR for missing requirements, contradictions, obvious broken APIs/types, or broad unrelated refactors.",
  "- WARN for small risk notes or test gaps (only if tests are in-scope).",
  "- Do not require changes to files that are not listed as units for this file."
].join("\n");
