// src/views/editView/editState.ts
import { ConsistencyIssue, ProposedFile } from "../../editing/pipeline/tools/types";
export type CloseReason = "discarded" | "superseded" | "completed" | "cleared";

export type PlannerTelemetry = {
  msTotal: number;
  mode: "plan" | "execute";
  units: number;
  diag: string[];

  traceFile?: string;
  traceId?: string;
  traceWriteError?: string;
};

export type RunRecord = {
  id: string;
  createdAtMs: number;
  prompt: string;

  closedAtMs?: number;
  closedReason?: CloseReason;

  // Text blobs shown in UI
  planSummary?: string;
  consistencySummary?: string;

  // For quick UI counts + per-file “⚠ n issues”
  consistencyIssues?: ConsistencyIssue[];

  // Optional telemetry from v2 planner
  telemetry?: PlannerTelemetry;

  // trace file location (written to workspace)
  traceFileUri?: string;

  // The actual proposal
  files: ProposedFile[];
};

export type ApplyStepFile = {
  uri: string;
  rel: string;
  beforeText: string;
  afterText: string;
  appliedChangeIds: string[];
};

export type ApplyStep = {
  id: string;
  label: string;
  createdAtMs: number;
  rolledBack: boolean;

  runId: string;
  runCreatedAtMs: number;
  prompt: string;

  files: ApplyStepFile[];
};

export type EditState = {
  activeRunId: string | null;
  runs: RunRecord[];
  steps: ApplyStep[];
};

export const EMPTY_STATE: EditState = {
  activeRunId: null,
  runs: [],
  steps: []
};
