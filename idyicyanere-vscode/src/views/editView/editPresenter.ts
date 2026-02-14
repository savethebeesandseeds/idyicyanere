import { ProposedFile } from "../../editing/pipeline/tools/types";
import { ApplyStep, EditState, RunRecord } from "./editState";
import { ActiveRunOut, RunHistoryOut } from "./editTypes";
import { fmtSegList } from "./editUtils";

function fileCounts(f: ProposedFile): { total: number; applied: number; discarded: number; pending: number } {
  const total = (f.changes ?? []).length;
  let applied = 0;
  let discarded = 0;
  let pending = 0;
  for (const c of f.changes ?? []) {
    if (c.discarded) discarded++;
    else if (c.applied) applied++;
    else pending++;
  }
  return { total, applied, discarded, pending };
}

function runCounts(r: RunRecord): { total: number; applied: number; discarded: number; pending: number } {
  let total = 0,
    applied = 0,
    discarded = 0,
    pending = 0;
  for (const f of r.files ?? []) {
    const c = fileCounts(f);
    total += c.total;
    applied += c.applied;
    discarded += c.discarded;
    pending += c.pending;
  }
  return { total, applied, discarded, pending };
}

export function buildEditViewPayload(
  state: EditState,
  busy: boolean
): { active: ActiveRunOut | null; history: RunHistoryOut[]; busy: boolean } {
  const runs = Array.isArray(state?.runs) ? state.runs : [];
  const steps = Array.isArray(state?.steps) ? state.steps : [];

  const activeRunId = typeof state?.activeRunId === "string" ? state.activeRunId : null;
  const active = activeRunId ? runs.find((r) => r?.id === activeRunId) ?? null : null;

  const activeOut: ActiveRunOut | null = active
    ? {
        id: active.id,
        createdAtMs: active.createdAtMs,
        prompt: active.prompt,
        planSummary: active.planSummary,
        consistencySummary: active.consistencySummary,
        issueCount: (active.consistencyIssues ?? []).length,
        traceFileUri: active.traceFileUri,
        files: (active.files ?? []).map((f) => {
          const c = fileCounts(f);

          // Changes are sequential per file (diff queue). Only the first pending is actionable.
          const ordered = [...(f.changes ?? [])].sort((a, b) => {
            const di = Number(a?.index) - Number(b?.index);
            if (di) return di;
            return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
          });

          let pendingSeen = false;
          const changesOut = ordered.map((x) => {
            const pending = !x.discarded && !x.applied;
            const locked = pending && pendingSeen;
            const lockReason = locked ? "Apply/discard earlier changes in this file first." : undefined;
            if (pending) pendingSeen = true;

            return {
              id: x.id,
              index: x.index,
              start: x.start,
              end: x.end,
              applied: x.applied,
              discarded: x.discarded,
              locked,
              lockReason,
              message: x.message,
              newText: x.newText,
            };
          });

          return {
            uri: f.uri,
            rel: f.rel,
            status: f.status,
            message: f.message,

            total: c.total,
            applied: c.applied,
            discarded: c.discarded,
            pending: c.pending,

            changes: changesOut,
          };
        }),
      }
    : null;

  const sortedRuns = [...runs].sort((a, b) => b.createdAtMs - a.createdAtMs);

  const history: RunHistoryOut[] = sortedRuns.map((r) => {
    const rc = runCounts(r);

    const runSteps = steps
      .filter((s) => s.runId === r.id)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((s) => {
        return {
          id: s.id,
          createdAtMs: s.createdAtMs,
          label: s.label,
          rolledBack: s.rolledBack,
          fileCount: (s.files ?? []).length,
          // appliedChangeIds intentionally omitted (unknown without step schema)
        };
      });

    const files = (r.files ?? [])
      .filter((f) => (f.changes ?? []).length > 0)
      .map((f) => {
        const fc = fileCounts(f);

        const pendingSegs = fmtSegList(
          (f.changes ?? [])
            .filter((c) => !c.discarded && !c.applied)
            .map((c) => c.index + 1)
        );
        const discardedSegs = fmtSegList((f.changes ?? []).filter((c) => c.discarded).map((c) => c.index + 1));
        const appliedSegs = fmtSegList(
          (f.changes ?? [])
            .filter((c) => !c.discarded && c.applied)
            .map((c) => c.index + 1)
        );

        return {
          rel: f.rel,
          status: f.status as any, // ideally tighten ProposedFile["status"] to match HistoryFileSummary
          total: fc.total,
          applied: fc.applied,
          discarded: fc.discarded,
          pending: fc.pending,

          pendingSegs,
          discardedSegs,
          appliedSegs,
        };
      });

    return {
      id: r.id,
      createdAtMs: r.createdAtMs,
      prompt: r.prompt,

      isActive: activeRunId === r.id,

      totalChanges: rc.total,
      appliedChanges: rc.applied,
      discardedChanges: rc.discarded,
      pendingChanges: rc.pending,

      files,
      steps: runSteps,
    };
  });

  return { active: activeOut, history, busy };
}
