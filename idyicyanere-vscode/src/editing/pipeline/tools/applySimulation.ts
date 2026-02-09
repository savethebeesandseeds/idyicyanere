import { ProposedChange, ConsistencyIssue } from "./types";
import { normalizeRel } from "../utils";

export function applyChangesDeterministic(params: {
  rel: string;
  oldText: string;
  changes: ProposedChange[];
}): { afterText: string; appliedIds: string[]; issues: ConsistencyIssue[] } {
  const rel = normalizeRel(params.rel);
  const oldText = params.oldText;

  const issues: ConsistencyIssue[] = [];
  const appliedIds: string[] = [];

  const changes = (params.changes ?? [])
    .filter((c) => c && !c.discarded && c.newText !== c.oldText)
    .slice()
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));

  let cursor = 0;
  const parts: string[] = [];

  for (const c of changes) {
    const start = Math.trunc(Number(c.start));
    const end = Math.trunc(Number(c.end));

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0 || start > end) {
      issues.push({
        severity: "error",
        rel,
        message: `Invalid change range [${c.start}..${c.end}]`,
        suggestion: "Re-plan this unit change.",
        source: "apply"
      });
      continue;
    }

    if (end > oldText.length) {
      issues.push({
        severity: "error",
        rel,
        message: `Change range exceeds file length: [${start}..${end}] > ${oldText.length}`,
        suggestion: "Re-plan against current file contents.",
        source: "apply"
      });
      continue;
    }

    if (start < cursor) {
      issues.push({
        severity: "error",
        rel,
        message: `Overlapping changes detected around offset ${start}.`,
        suggestion: "Re-plan; changes must be non-overlapping.",
        source: "apply"
      });
      continue;
    }

    const baselineSlice = oldText.slice(start, end);
    if (baselineSlice !== c.oldText) {
      issues.push({
        severity: "error",
        rel,
        message: `Baseline mismatch at [${start}..${end}] (change.oldText does not match baseline).`,
        suggestion: "Re-plan against current file contents; baseline may have changed.",
        source: "apply"
      });
      continue;
    }

    parts.push(oldText.slice(cursor, start));
    parts.push(c.newText);
    cursor = end;
    appliedIds.push(c.id);
  }

  parts.push(oldText.slice(cursor));
  return { afterText: parts.join(""), appliedIds, issues };
}
