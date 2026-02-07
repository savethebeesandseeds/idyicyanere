import * as vscode from "vscode";
import { log } from "../../logging/logger";
import { ProposedContentProvider } from "../../editing/proposedContentProvider";
import { ProposedChange, ProposedFile } from "../../editing/editTypes";
import { ApplyStep, ApplyStepFile, RunRecord } from "./editState";
import { EditHost } from "./editHost";
import { makeId } from "./editUtils";
import {
  computeTextAfterApplyingOne,
  computeTextCurrent,
  computeTextFinal,
  detectEol,
  normalizeEol,
  normalizeFileChangeEols,
  validateProposedFile
} from "./editTextOps";

export type ApplyDeps = {
  proposedProvider: ProposedContentProvider;
};

function ensureBaselineOrError(host: EditHost, file: ProposedFile, action: string): boolean {
  if (file.oldText === undefined) {
    host.ui({ type: "error", text: `Cannot ${action}: baseline text missing. Re-run Plan changes.` }, "baselineMissing");
    return false;
  }
  return true;
}

function findChangeById(run: RunRecord, changeId: string): { file: ProposedFile; change: ProposedChange } | null {
  for (const f of run.files ?? []) {
    const ch = (f.changes ?? []).find((c) => c.id === changeId);
    if (ch) return { file: f, change: ch };
  }
  return null;
}

function resolveChange(
  run: RunRecord,
  uriStr: string | undefined,
  changeId: string
): { uriStr: string; file: ProposedFile; ch: ProposedChange } | null {
  if (uriStr) {
    const file = (run.files ?? []).find((f) => f.uri === uriStr);
    const ch = (file?.changes ?? []).find((c) => c.id === changeId);
    return file && ch ? { uriStr, file, ch } : null;
  }

  const hit = findChangeById(run, changeId);
  if (!hit) return null;

  const resolvedUri = hit.file.uri;
  if (!resolvedUri) return null;

  return { uriStr: resolvedUri, file: hit.file, ch: hit.change };
}

function makeStep(run: RunRecord, label: string): ApplyStep {
  return {
    id: makeId("step"),
    label,
    createdAtMs: Date.now(),
    rolledBack: false,
    runId: run.id,
    runCreatedAtMs: run.createdAtMs,
    prompt: run.prompt,
    files: []
  };
}

function upsertProposed(deps: ApplyDeps, run: RunRecord, file: ProposedFile): void {
  const proposedUri = deps.proposedProvider.makeUri(run.id, file.rel);
  // Default to "current" so we never accidentally render *all* pending diffs.
  deps.proposedProvider.set(proposedUri, computeTextCurrent(file));
}

function upsertProposedPreview(deps: ApplyDeps, run: RunRecord, file: ProposedFile, changeId: string): void {
  const proposedUri = deps.proposedProvider.makeUri(run.id, file.rel);
  deps.proposedProvider.set(proposedUri, computeTextAfterApplyingOne(file, changeId));
}

function lastActiveStepIndex(steps: ApplyStep[]): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (!steps[i].rolledBack) return i;
  }
  return -1;
}

type PreparedReplace = {
  uri: vscode.Uri;
  rel: string;
  doc: vscode.TextDocument;
  beforeText: string;
  afterText: string;
  fullRange: vscode.Range;
};

/**
 * Preflight + open docs for a set of whole-file replaces.
 * Ensures:
 *  - doc not dirty
 *  - current content matches expectedBefore (caller-supplied)
 */
async function prepareWholeFileReplaces(params: {
  ops: Array<{ uri: vscode.Uri; rel: string; expectedBefore: string; afterText: string }>;
  purpose: string;
}): Promise<PreparedReplace[]> {
  const prepared: PreparedReplace[] = [];

  for (const op of params.ops) {
    const doc = await vscode.workspace.openTextDocument(op.uri);

    if (doc.isDirty) {
      throw new Error(
        `Cannot ${params.purpose}: ${op.rel} has unsaved changes. Save/revert the file, then retry.`
      );
    }

    const beforeText = doc.getText();
    if (beforeText !== op.expectedBefore) {
      // Give a little context in the message without dumping file contents.
      throw new Error(
        `Cannot ${params.purpose}: ${op.rel} has changed since planning/applying. Re-run Plan changes.`
      );
    }

    // Preserve the document's EOL style in the applied content.
    const eol = detectEol(beforeText);
    const afterText = normalizeEol(op.afterText, eol);

    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(beforeText.length));

    prepared.push({ uri: op.uri, rel: op.rel, doc, beforeText, afterText, fullRange });
  }

  return prepared;
}

/**
 * Apply all prepared replaces as ONE WorkspaceEdit. Save all changed docs.
 * If anything fails after applying, we attempt a revert back to beforeText.
 */
async function applyPreparedAsTransaction(prepared: PreparedReplace[], purpose: string): Promise<void> {
  if (!prepared.length) return;

  let applied = false;

  try {
    const edit = new vscode.WorkspaceEdit();
    for (const p of prepared) edit.replace(p.uri, p.fullRange, p.afterText);

    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) throw new Error(`Failed to apply workspace edit (${purpose}).`);

    applied = true;

    // Save each doc deterministically; if any fails, revert transaction.
    for (const p of prepared) {
      const saved = await p.doc.save();
      if (!saved) throw new Error(`Failed to save file after ${purpose}: ${p.rel}`);
    }
  } catch (err) {
    // Best-effort revert if we already applied edits.
    if (applied) {
      try {
        const revert = new vscode.WorkspaceEdit();
        for (const p of prepared) {
          const curLen = p.doc.getText().length;
          const curRange = new vscode.Range(p.doc.positionAt(0), p.doc.positionAt(curLen));
          revert.replace(p.uri, curRange, p.beforeText);
        }

        const ok2 = await vscode.workspace.applyEdit(revert);
        if (ok2) {
          for (const p of prepared) {
            try { await p.doc.save(); } catch { /* ignore */ }
          }
        }
      } catch (e2: any) {
        log.caught("applyPreparedAsTransaction revert failed", e2);
      }
    }

    throw err;
  }
}

export async function handleDiscardRun(host: EditHost): Promise<void> {
  const run = host.getActiveRun();
  if (!run) return;

  const state = host.getState();

  run.closedAtMs = Date.now();
  run.closedReason = "discarded";
  state.activeRunId = null;

  host.scheduleSave();
  host.ui({ type: "status", text: "Instruction discarded (kept in history)." }, "discardRun");
  await host.sendState();
}

export async function handleClearView(host: EditHost): Promise<void> {
  const run = host.getActiveRun();
  const state = host.getState();

  // If nothing is active, still clear the active pointer (defensive).
  if (!run) {
    state.activeRunId = null;
    host.scheduleSave();
    host.ui({ type: "status", text: "Cleared view." }, "clearView/noActive");
    await host.sendState();
    return;
  }

  // Close the run, but keep it in history (no deletion).
  if (!run.closedAtMs) run.closedAtMs = Date.now();
  if (!run.closedReason) run.closedReason = "completed";

  state.activeRunId = null;

  host.scheduleSave();
  host.ui({ type: "status", text: "Cleared view (history kept)." }, "clearView");
  await host.sendState();
}

export async function handleOpenDiff(host: EditHost, deps: ApplyDeps, uriStr: string, changeId?: string): Promise<void> {
  const run = host.getActiveRun();
  if (!run) return;

  const file = run.files.find((f:any) => f.uri === uriStr);
  if (!file) {
    log.warn("handleOpenDiff: file missing in run", { uriStr, runId: run.id });
    host.ui({ type: "error", text: "Internal error: file missing from active run. Re-run Plan changes." }, "openDiff/fileMissing");
    return;
  }

  if (!ensureBaselineOrError(host, file, "open diff")) return;

  // Keep proposed text normalized and stable for diffs.
  normalizeFileChangeEols(file);

  const fileUri = vscode.Uri.parse(uriStr);

  const proposedUri = deps.proposedProvider.makeUri(run.id, file.rel);
  // If a change is selected, only preview that change (plus already-applied ones).
  const hasSelected =
    typeof changeId === "string" &&
    changeId.length > 0 &&
    (file.changes ?? []).some((c:any) => c.id === changeId);

  if (hasSelected) upsertProposedPreview(deps, run, file, changeId!);
  else upsertProposed(deps, run, file);

  const title = `idyicyanere: ${file.rel} (preview)`;
  await vscode.commands.executeCommand("vscode.diff", fileUri, proposedUri, title);
}

export async function handleUpdateDraft(
  host: EditHost,
  deps: ApplyDeps,
  uriStr: string | undefined,
  changeId: string,
  newText: string
): Promise<void> {
  const run = host.getActiveRun();
  if (!run) return;

  const r = resolveChange(run, uriStr, changeId);
  if (!r) {
    host.ui(
      { type: "error", text: "Selected change no longer exists. Re-select, or re-run Plan changes." },
      "resolveChange/missing"
    );
    return;
  }

  const { file, ch } = r;
  if (ch.applied || ch.discarded) return;
  if (!ensureBaselineOrError(host, file, "update draft")) return;

  // Keep proposed text normalized and stable for diffs.
  normalizeFileChangeEols(file);

  // Normalize EOL to baseline to prevent line-ending diffs and later apply mismatches.
  const eol = detectEol(file.oldText ?? "");
  ch.newText = normalizeEol(String(newText ?? ""), eol);

  // Only notify UI once per change (avoids spamming sendState on every keystroke).
  const wasEdited = ch.message === "Edited";
  if (!wasEdited) ch.message = "Edited";

  // Keep diff preview focused on ONLY this selected change.
  upsertProposedPreview(deps, run, file, changeId);
  host.scheduleSave();

  if (!wasEdited) {
    await host.sendState();
  }
}

export async function handleDiscardChange(
  host: EditHost,
  deps: ApplyDeps,
  uriStr: string | undefined,
  changeId: string
): Promise<void> {
  const run = host.getActiveRun();
  if (!run) return;

  const r = resolveChange(run, uriStr, changeId);
  if (!r) {
    host.ui({ type: "error", text: "Selected change no longer exists. Re-select, or re-run Plan changes." }, "discardChange/missing");
    return;
  }

  const { file, ch } = r;

  if (ch.applied) {
    host.ui({ type: "error", text: "Already applied. Roll back first." }, "discardChange/alreadyApplied");
    return;
  }

  ch.discarded = true;
  ch.message = "Discarded";

  // After discard, default preview back to "current" (no accidental all-diffs view).
  // After apply, keep proposed in "current" until UI selects next change.
  upsertProposed(deps, run, file);


  host.scheduleSave();
  await host.sendState();
}

export async function handleApplySelected(
  host: EditHost,
  deps: ApplyDeps,
  uriStr: string | undefined,
  changeId: string,
  newText: string
): Promise<void> {
  const run = host.getActiveRun();
  if (!run) return;

  const r = resolveChange(run, uriStr, changeId);
  if (!r) {
    host.ui({ type: "error", text: "Selected change no longer exists. Re-select, or re-run Plan changes." }, "resolveChange/missing");
    return;
  }

  const { file, ch } = r;

  if (!ensureBaselineOrError(host, file, "apply")) return;

  if (ch.applied) {
    host.ui({ type: "error", text: "Already applied." }, "applySelected/alreadyApplied");
    return;
  }
  if (ch.discarded) {
    host.ui({ type: "error", text: "Cannot apply: this change is discarded." }, "applySelected/discarded");
    return;
  }

  // Normalize file-level EOL first (for stable expectedBefore computations).
  normalizeFileChangeEols(file);

  // Store edited text (normalized) on the change.
  const eol = detectEol(file.oldText ?? "");
  ch.newText = normalizeEol(String(newText ?? ""), eol);
  ch.message = "Edited";

  const integrity = validateProposedFile(file);
  const fatal = integrity.filter((x) => x.severity === "error");
  if (fatal.length) {
    host.ui(
      { type: "error", text: `Cannot apply: proposal integrity failed.\n- ${fatal.map((x) => x.message).join("\n- ")}` },
      "applySelected/integrity"
    );
    return;
  }

  const stepLabel = `Apply: ${file.rel} (unit #${ch.index + 1})`;
  const statusLabel = `Applying ${file.rel} (unit #${ch.index + 1})…`;

  await host.withBusy("EditApply.handleApplySelected", statusLabel, async () => {
    await host.ensure_index();

    const expectedBefore = computeTextCurrent(file);
    const afterText = computeTextAfterApplyingOne(file, changeId, ch.newText);

    // Transactionally replace the whole file.
    const uri = vscode.Uri.parse(file.uri);
    const prepared = await prepareWholeFileReplaces({
      purpose: "apply",
      ops: [{ uri, rel: file.rel, expectedBefore, afterText }]
    });

    await applyPreparedAsTransaction(prepared, "apply");

    // Now that the transaction is committed, mutate state.
    ch.applied = true;
    ch.message = "Applied";

    upsertProposed(deps, run, file);

    const step = makeStep(run, stepLabel);
    step.files.push({
      uri: file.uri,
      rel: file.rel,
      beforeText: prepared[0].beforeText,
      afterText: prepared[0].afterText,
      appliedChangeIds: [changeId]
    });

    const state = host.getState();
    state.steps.push(step);

    host.scheduleSave();
    await vscode.commands.executeCommand("idyicyanere.refreshAll");

    host.ui({ type: "status", text: "Applied change." }, "applySelected/done");
    await host.sendState();
  });
}

export async function handleApplyAll(host: EditHost, deps: ApplyDeps): Promise<void> {
  const run = host.getActiveRun();
  if (!run) return;

  const targets = (run.files ?? []).filter((f:any) => {
    const hasPending = (f.changes ?? []).some((c:any) => !c.discarded && !c.applied);
    return f.status === "changed" && f.oldText !== undefined && hasPending;
  });

  if (!targets.length) {
    host.ui({ type: "status", text: "Nothing pending to apply." }, "applyAll/nothingPending");
    return;
  }

  await host.withBusy("EditApply.handleApplyAll", `Applying all pending (${targets.length} file(s))…`, async () => {
    await host.ensure_index();

    // Pre-build operations and validate everything BEFORE writing anything.
    const ops: Array<{ uri: vscode.Uri; rel: string; expectedBefore: string; afterText: string; file: ProposedFile; appliedIds: string[] }> = [];

    for (const f of targets) {
      if (!ensureBaselineOrError(host, f, "apply")) continue;

      normalizeFileChangeEols(f);

      const integrity = validateProposedFile(f);
      const fatal = integrity.filter((x) => x.severity === "error");
      if (fatal.length) {
        throw new Error(`Cannot apply all: integrity failed for ${f.rel}. Re-run Plan changes.`);
      }

      const pending = (f.changes ?? []).filter((c:any) => !c.discarded && !c.applied);
      const appliedIds = pending.map((c:any) => c.id);

      const expectedBefore = computeTextCurrent(f);
      const afterText = computeTextFinal(f);

      ops.push({
        uri: vscode.Uri.parse(f.uri),
        rel: f.rel,
        expectedBefore,
        afterText,
        file: f,
        appliedIds
      });
    }

    if (!ops.length) {
      host.ui({ type: "status", text: "Nothing pending to apply." }, "applyAll/nothingAfterFilter");
      return;
    }

    host.ui({ type: "status", text: `Preflighting ${ops.length} file(s)…` }, "applyAll/preflight");

    const prepared = await prepareWholeFileReplaces({
      purpose: "apply all",
      ops: ops.map((x) => ({ uri: x.uri, rel: x.rel, expectedBefore: x.expectedBefore, afterText: x.afterText }))
    });

    host.ui({ type: "status", text: `Applying ${ops.length} file(s) atomically…` }, "applyAll/apply");

    await applyPreparedAsTransaction(prepared, "apply all");

    // Commit state changes only AFTER transaction succeeds.
    const step = makeStep(run, `Apply all pending (${ops.length})`);

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const p = prepared[i];

      for (const c of (op.file.changes ?? [])) {
        if (op.appliedIds.includes(c.id)) {
          c.applied = true;
          c.message = "Applied";
        }
      }

      upsertProposed(deps, run, op.file);

      const sf: ApplyStepFile = {
        uri: op.file.uri,
        rel: op.file.rel,
        beforeText: p.beforeText,
        afterText: p.afterText,
        appliedChangeIds: op.appliedIds
      };

      step.files.push(sf);
    }

    if (step.files.length) {
      const state = host.getState();
      state.steps.push(step);
      host.scheduleSave();
      await vscode.commands.executeCommand("idyicyanere.refreshAll");
    }

    host.ui({ type: "status", text: "Applied all pending changes." }, "applyAll/done");
    await host.sendState();
  });
}

export async function handleRollback(host: EditHost, deps: ApplyDeps, stepId: string): Promise<void> {
  const state = host.getState();

  const idx = (state.steps ?? []).findIndex((s:any) => s.id === stepId);
  if (idx < 0) return;

  const lastActive = lastActiveStepIndex(state.steps ?? []);
  if (idx !== lastActive) {
    host.ui({ type: "error", text: "Rollback is sequential: roll back the most recent step first." }, "rollback/notLast");
    return;
  }

  const step = state.steps[idx];
  if (step.rolledBack) return;

  await host.withBusy("EditApply.handleRollback", `Rolling back: ${step.label}`, async () => {
    // Preflight: refuse rollback if any file drifted since the apply step.
    const ops: Array<{ uri: vscode.Uri; rel: string; expectedBefore: string; afterText: string; beforeText: string; stepFile: ApplyStepFile }> = [];

    for (const sf of step.files ?? []) {
      const uri = vscode.Uri.parse(sf.uri);
      const rel = sf.rel;

      // expectedBefore is what is currently on disk and MUST equal sf.afterText
      // We use prepareWholeFileReplaces to verify doc state, but it needs expectedBefore and new afterText.
      ops.push({
        uri,
        rel,
        expectedBefore: sf.afterText,
        afterText: sf.beforeText, // "after" for the rollback transaction is the step's beforeText
        beforeText: sf.beforeText,
        stepFile: sf
      });
    }

    const prepared = await prepareWholeFileReplaces({
      purpose: "rollback",
      ops: ops.map((x) => ({
        uri: x.uri,
        rel: x.rel,
        expectedBefore: x.expectedBefore, // must match sf.afterText
        afterText: x.afterText // replace with sf.beforeText
      }))
    });

    await applyPreparedAsTransaction(prepared, "rollback");

    // State commit: mark changes un-applied + refresh proposed view.
    for (const sf of step.files ?? []) {
      const run = state.runs.find((r:any) => r.id === step.runId);
      const pf = run?.files.find((x:any) => x.uri === sf.uri);

      if (run && pf) {
        for (const cid of sf.appliedChangeIds ?? []) {
          const ch = (pf.changes ?? []).find((c:any) => c.id === cid);
          if (ch) {
            ch.applied = false;
            if (!ch.discarded) ch.message = "Rolled back";
          }
        }
        upsertProposed(deps, run, pf);
      }
    }

    step.rolledBack = true;

    host.scheduleSave();
    await vscode.commands.executeCommand("idyicyanere.refreshAll");

    host.ui({ type: "status", text: "Rollback complete." }, "rollback/done");
    await host.sendState();
  });
}