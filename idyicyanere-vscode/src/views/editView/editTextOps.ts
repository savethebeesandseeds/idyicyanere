import { ProposedFile, ProposedChange } from "../../editing/pipeline/tools/types";
import { tryApplyUnifiedDiff, renderUnifiedDiffIssues } from "../../editing/pipeline/tools/unitDiff";

export type TextEol = "\n" | "\r\n";

export type ApplyIntegrityIssue = {
  severity: "warn" | "error";
  message: string;
  changeId?: string;
};

export function sortChanges(file: ProposedFile): ProposedChange[] {
  // In diff-queue mode, order is strictly by "index".
  return [...(file.changes ?? [])].sort((a, b) => {
    const di = Number(a?.index) - Number(b?.index);
    if (di) return di;
    return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
  });
}

export function detectEol(text: string): TextEol {
  const t = String(text ?? "");
  return t.includes("\r\n") ? "\r\n" : "\n";
}

export function normalizeEol(text: string, eol: TextEol): string {
  const t = String(text ?? "");
  const lf = t.replace(/\r\n/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

/**
 * Normalize ALL proposed newText fragments to match the file's baseline EOL.
 * In diff-queue mode, `newText` is a unified diff patch, NOT file text.
 * We intentionally do NOT rewrite it.
 */
export function normalizeFileChangeEols(file: ProposedFile): TextEol {
  const base = file.oldText ?? "";
  const eol = detectEol(base);
  return eol;
}

function applyDiffOrThrow(rel: string, curText: string, diff: string, changeId: string): string {
  const sim = tryApplyUnifiedDiff({ rel, oldText: curText, diff });
  if (sim.ok) return String(sim.afterText ?? curText);
  const detail = renderUnifiedDiffIssues(sim.issues ?? []);
  throw new Error(`Diff does not apply for ${rel} (change ${changeId}).\n${detail}`);
}


export function validateProposedFile(file: ProposedFile): ApplyIntegrityIssue[] {
  const issues: ApplyIntegrityIssue[] = [];
  const base = file.oldText;

  if (base === undefined) {
    issues.push({ severity: "error", message: "Baseline text missing (oldText is undefined)." });
    return issues;
  }

  const rel = String(file.rel ?? "");
  const changes = sortChanges(file);

  let cur = base;
  for (const c of changes) {
    if (c.discarded) continue;
    const diff = String(c?.newText ?? "");
    if (!diff.trim()) {
      issues.push({ severity: "error", message: "Empty diff patch.", changeId: c.id });
      break;
    }
    try {
      cur = applyDiffOrThrow(rel, cur, diff, c.id);
    } catch (e: any) {
      issues.push({
        severity: "error",
        message: String(e?.message ?? e),
        changeId: c.id
      });
      break;
    }
  }

  return issues;
}

export function computeTextCurrent(file: ProposedFile): string {
  const base = file.oldText ?? "";
  const rel = String(file.rel ?? "");
  const changes = sortChanges(file);

  let cur = base;
  for (const c of changes) {
    if (c.discarded) continue;
    if (!c.applied) continue;
    const diff = String(c?.newText ?? "");
    cur = applyDiffOrThrow(rel, cur, diff, c.id);
  }
  return cur;
}

export function computeTextFinal(file: ProposedFile): string {
  const base = file.oldText ?? "";
  const rel = String(file.rel ?? "");
  const changes = sortChanges(file);

  let cur = base;
  for (const c of changes) {
    if (c.discarded) continue;
    const diff = String(c?.newText ?? "");
    cur = applyDiffOrThrow(rel, cur, diff, c.id);
  }
  return cur;
}

export function computeTextAfterApplyingOne(file: ProposedFile, changeId: string, overrideNewText?: string): string {
  const base = file.oldText ?? "";
  const rel = String(file.rel ?? "");
  const changes = sortChanges(file);

  let cur = base;
  for (const c of changes) {
    if (c.discarded) continue;
    const isThis = c.id === changeId;
    const shouldApply = c.applied || isThis;
    if (!shouldApply) continue;

    const diff = isThis && overrideNewText !== undefined ? String(overrideNewText ?? "") : String(c?.newText ?? "");
    cur = applyDiffOrThrow(rel, cur, diff, c.id);
  }
  return cur;
}

/**
 * Preview helper: apply ALL non-discarded diffs up to and including `changeId`
 * (even if earlier ones are not yet applied). Useful for diff previews.
 */
export function computeTextPreviewThrough(file: ProposedFile, changeId: string, overrideNewText?: string): string {
  const base = file.oldText ?? "";
  const rel = String(file.rel ?? "");
  const changes = sortChanges(file);

  const idx = changes.findIndex((c) => c.id === changeId);
  if (idx < 0) return computeTextCurrent(file);

  let cur = base;
  for (let i = 0; i <= idx; i++) {
    const c = changes[i];
    if (c.discarded) continue;
    const isThis = c.id === changeId;
    const diff = isThis && overrideNewText !== undefined ? String(overrideNewText ?? "") : String(c?.newText ?? "");
    cur = applyDiffOrThrow(rel, cur, diff, c.id);
  }
  return cur;
}