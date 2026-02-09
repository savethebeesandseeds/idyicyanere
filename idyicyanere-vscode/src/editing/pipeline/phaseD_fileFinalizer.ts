import { OpenAIService } from "../../openai/openaiService";
import { ConsistencyIssue, ProposedChange, ProposedFile } from "./tools/types";
import { ApplyCheckFile, PlannerConfig } from "./commons";
import { PROMPT_FILE_VALIDATE } from "./prompts";
import { applyChangesDeterministic } from "./tools/applySimulation";
import {
  convertLineEndings,
  detectDominantLineEnding,
  hashHex,
  isWhitespaceOnlyChange,
  normalizeRel,
  previewHeadTail,
  promptWantsFormatting,
  sevRank
} from "./utils";

export type FileUnitSummary = {
  id: string;
  title: string;
  instructions: string;
  acceptanceCriteria?: string[];
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

export async function finalizeFile(params: {
  cfg: PlannerConfig;
  userPrompt: string;
  rel: string;
  uri: string;

  oldText: string;
  changes: ProposedChange[];

  unitIssues: ConsistencyIssue[];
  unitsForFile: FileUnitSummary[];

  openai: OpenAIService;
}): Promise<{ proposedFile: ProposedFile; applyCheckFile: ApplyCheckFile; issues: ConsistencyIssue[] }> {
  const cfg = params.cfg;
  const rel = normalizeRel(params.rel);
  const wantsFmt = promptWantsFormatting(params.userPrompt);

  // Defensive copy (we mutate discard flags / messages)
  const changes = (params.changes ?? []).slice().sort((a, b) => (a.start - b.start) || (a.end - b.end));

  const oldText = String(params.oldText ?? "");
  const targetEol = cfg.guards.preserveLineEndings && !wantsFmt ? detectDominantLineEnding(oldText) : null;

  // Guards on each change
  for (const c of changes) {
    if (!c || c.discarded) continue;

    if (targetEol && !wantsFmt) c.newText = convertLineEndings(c.newText, targetEol);

    if (cfg.guards.discardWhitespaceOnlyChanges && !wantsFmt) {
      if (isWhitespaceOnlyChange(c.oldText, c.newText)) {
        c.discarded = true;
        c.message = c.message ? `${c.message} (discarded: whitespace-only)` : "Discarded: whitespace-only";
      }
    }
  }

  const realChanges = changes.filter((c) => c && !c.discarded && c.newText !== c.oldText);

  // Scope coverage checks (minimal)
  const scopeIssues: ConsistencyIssue[] = [];
  if (realChanges.length) {
    const totalLen = Math.max(1, oldText.length);
    const ranges = realChanges
      .map((c) => ({ s: Math.max(0, c.start), e: Math.max(0, c.end) }))
      .filter((r) => r.e > r.s)
      .sort((a, b) => a.s - b.s || a.e - b.e);
    let covered = 0;
    let curS = -1, curE = -1;
    for (const r of ranges) {
      if (curS < 0) { curS = r.s; curE = r.e; continue; }
      if (r.s <= curE) curE = Math.max(curE, r.e);
      else { covered += (curE - curS); curS = r.s; curE = r.e; }
    }
    if (curS >= 0) covered += (curE - curS);
    const coverage = covered / totalLen;

    if (coverage >= cfg.guards.maxPatchCoverageError) {
      scopeIssues.push({
        severity: "error",
        rel,
        message: `Edits touch ~${Math.round(coverage * 100)}% of file content (very broad).`,
        suggestion: "Narrow the target region or split into smaller unit changes.",
        source: "scope"
      });
    } else if (coverage >= cfg.guards.maxPatchCoverageWarn) {
      scopeIssues.push({
        severity: "warn",
        rel,
        message: `Edits touch ~${Math.round(coverage * 100)}% of file content (broad).`,
        suggestion: "Confirm scope is intended; consider splitting units.",
        source: "scope"
      });
    }
  }

  // Apply simulation
  const sim = applyChangesDeterministic({ rel, oldText, changes: realChanges });
  const applyIssues = sim.issues ?? [];

  // If net no-op, discard all real changes (keeps UI clean)
  if (sim.afterText === oldText && realChanges.length) {
    for (const c of realChanges) {
      c.discarded = true;
      c.message = c.message ? `${c.message} (discarded: net no-op)` : "Discarded: net no-op";
    }
  }

  const applyOk = !scopeIssues.some((x) => sevRank(x.severity) >= 2) && !applyIssues.some((x) => sevRank(x.severity) >= 2);

  const applyCheckFile: ApplyCheckFile = {
    rel,
    uri: params.uri,
    ok: applyOk,
    appliedChangeIds: sim.appliedIds,
    afterTextChars: sim.afterText.length,
    afterTextHash: hashHex(sim.afterText, 10),
    issues: [...scopeIssues, ...applyIssues]
  };

  // Final semantic validation (optional)
  let semanticIssues: ConsistencyIssue[] = [];
  const netChanged = sim.afterText !== oldText;
  const semanticMode = cfg.validation.final;

  if (applyOk && netChanged && realChanges.length && semanticMode !== "off") {
    try {
      const modelKind = semanticMode === "heavy" ? "heavy" : "light";
      const modelOverride = semanticMode === "heavy" ? cfg.models.modelHeavy : cfg.models.modelLight;

      const val = await params.openai.language_request_with_JSON_out<any>({
        modelKind,
        modelOverride,
        instructions: PROMPT_FILE_VALIDATE,
        input: [
          `FILE: ${rel}`,
          "",
          "UNITS FOR THIS FILE:",
          JSON.stringify(params.unitsForFile ?? [], null, 2),
          "",
          "PROPOSED CHANGES (HUNKS):",
          JSON.stringify(
            realChanges.slice(0, 60).map((c) => ({
              id: c.id,
              start: c.start,
              end: c.end,
              oldLen: c.oldText.length,
              newLen: c.newText.length,
              message: c.message
            })),
            null,
            2
          ),
          "",
          "AFTER TEXT PREVIEW:",
          JSON.stringify(previewHeadTail(sim.afterText, 3500, 1200), null, 2),
          "",
          "KNOWN ISSUES SO FAR:",
          JSON.stringify(dedupeIssues([...(params.unitIssues ?? []), ...scopeIssues, ...applyIssues]).slice(0, 60), null, 2)
        ].join("\n"),
        maxRetries: 1
      });

      semanticIssues = Array.isArray(val?.issues)
        ? val.issues
            .map((x: any) => ({
              severity: x?.severity === "error" ? "error" : "warn",
              rel,
              message: String(x?.message ?? "").trim(),
              suggestion: x?.suggestion ? String(x.suggestion).trim() : undefined,
              source: "semantic" as const
            }))
            .filter((x: ConsistencyIssue) => !!x.message)
        : [];
    } catch (e: any) {
      semanticIssues = [{
        severity: "warn",
        rel,
        message: `Final file validation failed and was skipped.`,
        suggestion: "Re-run; if persistent, check model availability.",
        source: "semantic"
      }];
    }
  }

  const allIssues = dedupeIssues([...(params.unitIssues ?? []), ...scopeIssues, ...applyIssues, ...semanticIssues]);

  const hasErrors = allIssues.some((x) => sevRank(x.severity) >= 2);

  const finalReal = changes.filter((c) => c && !c.discarded && c.newText !== c.oldText);
  const finalNetChanged = netChanged && finalReal.length > 0;

  const status: ProposedFile["status"] = hasErrors ? "error" : finalNetChanged ? "changed" : "unchanged";

  const msgParts: string[] = [];
  msgParts.push(finalNetChanged ? `${finalReal.length} change(s)` : "No changes");
  if (scopeIssues.length) msgParts.push(`${scopeIssues.length} scope issue(s)`);
  if (applyIssues.length) msgParts.push(`${applyIssues.length} apply issue(s)`);
  if (semanticIssues.length) msgParts.push(`${semanticIssues.length} validation issue(s)`);

  const proposedFile: ProposedFile = {
    uri: params.uri,
    rel,
    status,
    message: msgParts.join(" · "),
    oldText,
    changes
  };

  return { proposedFile, applyCheckFile, issues: allIssues };
}
