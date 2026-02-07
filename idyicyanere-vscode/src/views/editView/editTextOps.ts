import { ProposedFile, ProposedChange } from "../../editing/editTypes";

export type TextEol = "\n" | "\r\n";

export type ApplyIntegrityIssue = {
  severity: "warn" | "error";
  message: string;
  changeId?: string;
};

export function sortChanges(file: ProposedFile): ProposedChange[] {
  return [...(file.changes ?? [])].sort((a, b) => {
    const ds = Number(a?.start) - Number(b?.start);
    if (ds) return ds;
    const de = Number(a?.end) - Number(b?.end);
    if (de) return de;
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
 * This prevents:
 *  - "phantom diffs" where only line endings differ
 *  - apply checks failing later because expectedBefore uses newText
 */
export function normalizeFileChangeEols(file: ProposedFile): TextEol {
  const base = file.oldText ?? "";
  const eol = detectEol(base);

  for (const c of file.changes ?? []) {
    if (typeof c?.newText === "string") c.newText = normalizeEol(c.newText, eol);
  }
  return eol;
}

export function validateProposedFile(file: ProposedFile): ApplyIntegrityIssue[] {
  const issues: ApplyIntegrityIssue[] = [];
  const base = file.oldText;

  if (base === undefined) {
    issues.push({ severity: "error", message: "Baseline text missing (oldText is undefined)." });
    return issues;
  }

  const changes = sortChanges(file);

  let prevEnd = -1;
  for (const c of changes) {
    const start = Number(c?.start);
    const end = Number(c?.end);

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      issues.push({ severity: "error", message: "Change has non-numeric start/end.", changeId: c?.id });
      continue;
    }

    if (start < 0 || end < start || end > base.length) {
      issues.push({
        severity: "error",
        message: `Change range out of bounds: [${start}..${end}] for base length ${base.length}.`,
        changeId: c.id
      });
      continue;
    }

    if (prevEnd > start) {
      issues.push({
        severity: "error",
        message: `Overlapping changes detected (prevEnd=${prevEnd} > start=${start}).`,
        changeId: c.id
      });
    }
    prevEnd = Math.max(prevEnd, end);

    const slice = base.slice(start, end);
    if (slice !== c.oldText) {
      issues.push({
        severity: "error",
        message: "Baseline mismatch: change.oldText does not match baseline slice at its [start..end]. Re-run Plan changes.",
        changeId: c.id
      });
    }

    if (!c.discarded && c.newText === c.oldText) {
      issues.push({
        severity: "warn",
        message: "Change newText equals oldText (no-op).",
        changeId: c.id
      });
    }
  }

  return issues;
}

export function computeTextCurrent(file: ProposedFile): string {
  const base = file.oldText ?? "";
  const changes = sortChanges(file);

  let out = "";
  let cur = 0;

  for (const c of changes) {
    out += base.slice(cur, c.start);
    if (!c.discarded && c.applied) out += c.newText;
    else out += base.slice(c.start, c.end);
    cur = c.end;
  }

  out += base.slice(cur);
  return out;
}

export function computeTextFinal(file: ProposedFile): string {
  const base = file.oldText ?? "";
  const changes = sortChanges(file);

  let out = "";
  let cur = 0;

  for (const c of changes) {
    out += base.slice(cur, c.start);
    if (!c.discarded) out += c.newText;
    else out += base.slice(c.start, c.end);
    cur = c.end;
  }

  out += base.slice(cur);
  return out;
}

export function computeTextAfterApplyingOne(file: ProposedFile, changeId: string, overrideNewText?: string): string {
  const base = file.oldText ?? "";
  const changes = sortChanges(file);

  let out = "";
  let cur = 0;

  for (const c of changes) {
    out += base.slice(cur, c.start);

    const isThis = c.id === changeId;
    const shouldApply = !c.discarded && (c.applied || isThis);

    if (shouldApply) out += isThis && overrideNewText !== undefined ? overrideNewText : c.newText;
    else out += base.slice(c.start, c.end);

    cur = c.end;
  }

  out += base.slice(cur);
  return out;
}