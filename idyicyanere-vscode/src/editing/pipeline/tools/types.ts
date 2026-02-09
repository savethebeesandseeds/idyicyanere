import * as vscode from "vscode";
import { OpenAIService } from "../../../openai/openaiService";

export type RagHit = {
  rel: string;
  start: number;
  end: number;
  score?: number;
  text?: string;
  startLine?: number;
  endLine?: number;
  fileHash?: string;
  chunkHash?: string;
};

export type RagStoreLike = {
  queryHits?: (qVec: Float32Array, k: number, metric: any, opts?: { rel?: string }) => Promise<RagHit[]>;
};

export type IncludedFile = { uri: vscode.Uri; rel: string; chunkChars: number };

export type ReadTextFileResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export type PlanMode = "plan" | "execute" | "auto";

export type PlanChangesParams = {
  prompt: string;
  mode?: PlanMode;
  files: IncludedFile[];
  readTextFile: (uri: vscode.Uri) => Promise<ReadTextFileResult>;
  openai: OpenAIService;
  config: ConfigService;
  ragStore?: RagStoreLike;
  onStatus?: (text: string) => void;
  onFileResult?: (index: number, pf: ProposedFile) => void;
};


// -------- Planner core types --------

export type ProposedChange = {
  id: string;
  index: number; // segment index (0-based)
  start: number; // offsets in baseline oldText
  end: number;

  oldText: string;
  newText: string;

  applied: boolean;
  discarded: boolean;
  message?: string;
};


export type ProposedFile = {
  uri: string;
  rel: string;

  status: "planning" | "changed" | "unchanged" | "skipped" | "error";
  message?: string;

  // baseline at planning time (required for safe apply)
  oldText?: string;

  changes: ProposedChange[];
};

export type ConsistencyIssue = {
  severity: "warn" | "error";
  rel?: string;
  message: string;
  suggestion?: string;

  /**
   * Optional provenance for better UI + debugging.
   * Not all producers fill this; treat as best-effort.
   */
  source?: "planner" | "router" | "scope" | "apply" | "semantic" | "diagnostic" | "tool";
  code?: string;
};

export type ApplyStepFile = {
  uri: string;
  rel: string;
  beforeText: string;
  afterText: string;
  appliedChangeIds: string[];
};

export type UnitTarget = {
  unitId: string;
  rel: string;
  uri: string;
  start: number;
  end: number;
  why: string;
  score?: number;
};

export type ApplyCheckFile = {
  rel: string;
  uri: string;
  ok: boolean;
  appliedChangeIds: string[];
  afterTextChars: number;
  afterTextHash: string;
  issues: ConsistencyIssue[];
};

export type ApplyCheckReport = {
  ok: boolean;
  summary: string;
  files: ApplyCheckFile[];
  issues: ConsistencyIssue[];
};

export type PlannerConfig = {
  trace: { enabled: boolean };

  models: {
    modelLight: string;
    modelHeavy: string;
    modelSuperHeavy: string;
  };

  parallel: {
    unitChanges: number;
    files: number;
  };

  rag: {
    enabled: boolean;
    k: number;
    metric: any;
  };

  segmentation: {
    newlineSnap: boolean;
    newlineSnapWindow: number;
    newlinePreferForward: boolean;
    minFragmentChars: number;
    maxFragmentChars: number;
    contextChars: number;
  };

  targeting: {
    useRagHits: boolean;
    maxCandidateFiles: number;
    padBeforeChars: number;
    padAfterChars: number;
    mergeGapChars: number;
    maxWindowsPerUnit: number;
  };

  attempts: {
    maxRounds: number;
    validateModel: "light" | "heavy";
  };

  guards: {
    discardWhitespaceOnlyChanges: boolean;
    preserveLineEndings: boolean;
    maxPatchCoverageWarn: number;
    maxPatchCoverageError: number;
  };

  validation: {
    final: "off" | "light" | "heavy";
  };
};
