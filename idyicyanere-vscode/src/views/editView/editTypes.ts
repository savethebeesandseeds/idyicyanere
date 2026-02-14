export type PlanModeUI = "plan" | "execute" | "auto";

export type WebviewIn =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "run"; prompt: string; mode?: PlanModeUI }
  | { type: "discardRun"; cancel?: boolean }
  | { type: "clearView" }
  | { type: "clearHistory" }
  | { type: "openFile"; uri: string }
  | { type: "openTrace"; uri: string }
  | { type: "openDiff"; uri: string; changeId?: string }
  | { type: "updateDraft"; uri?: string; changeId: string; newText: string }
  | { type: "applySelected"; uri?: string; changeId: string; newText: string }
  | { type: "discardChange"; uri?: string; changeId: string }
  | { type: "applyAll" }
  | { type: "rollback"; stepId: string }
  | { type: "clientError"; text: string; stack?: string }
  | { type: "clientLog"; text: string; data?: any };

export type ActiveRunOut = {
  id: string;
  createdAtMs: number;
  prompt: string;
  planSummary?: string;
  consistencySummary?: string;
  issueCount?: number;
  traceFileUri?: string;
  files: Array<{
    uri: string;
    rel: string;
    status: string;
    message?: string;

    total: number;
    applied: number;
    discarded: number;
    pending: number;

    changes: Array<{
      id: string;
      index: number;
      start: number;
      end: number;
      applied: boolean;
      discarded: boolean;
      locked?: boolean;
      lockReason?: string;
      message?: string;
      newText: string;
    }>;
  }>;
};


export type HistoryFileSummary = {
  rel: string;
  status: "changed" | "unchanged" | "skipped" | "error" | "planning"; // keep in sync with ProposedFile["status"]
  total: number;
  applied: number;
  discarded: number;
  pending: number;

  // UI strings (you’re printing "#1", "—", etc.)
  pendingSegs: string;
  discardedSegs: string;
  appliedSegs: string;
};

export type HistoryStepSummary = {
  // you printed steps: [] so shape unknown; make it future-proof but still useful
  id: string;
  createdAtMs: number;
  label?: string;

  // rollbacks / linkage
  rolledBack?: boolean;

  // optional rollup counts (handy for UI)
  fileCount?: number;
  appliedChangeIds?: string[];
};

export type RunHistoryOut = {
  id: string;            // run id
  createdAtMs: number;
  prompt: string;

  // UI state
  isActive: boolean;

  // rollups across all files
  totalChanges: number;
  appliedChanges: number;
  discardedChanges: number;
  pendingChanges: number;

  files: HistoryFileSummary[];
  steps: HistoryStepSummary[];
};

export type WebviewOut =
  | { type: "status"; text: string }
  | { type: "error"; text: string }
  | { type: "clearHistory"; text: string }
  | { type: "state"; payload: { active: ActiveRunOut | null; history: RunHistoryOut[]; busy: boolean } };
