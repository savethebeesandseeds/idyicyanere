// src/editing/pipeline2/commons.ts
import * as vscode from "vscode";
import { ConfigService } from "../../storage/configService";
import { OpenAIService } from "../../openai/openaiService";
import { ProposedFile, ConsistencyIssue } from "../editTypes";
import { clampInt } from "./utils";

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

// -------- Planner v2 core types --------

export type ChangeDescription = {
  summary: string;
  description: string;
  assumptions?: string[];
  constraints?: string[];
  nonGoals?: string[];
  acceptanceCriteria?: string[];
  risks?: string[];
};

export type UnitChange = {
  id: string;
  title: string;
  instructions: string;
  fileHints?: string[];
  anchors?: string[];
  acceptanceCriteria?: string[];
};

export type UnitSplitOut = {
  summary: string;
  units: UnitChange[];
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

export type Planner2Config = {
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

function asBool(x: any, def: boolean): boolean {
  if (typeof x === "boolean") return x;
  if (typeof x === "string") {
    const t = x.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes" || t === "on") return true;
    if (t === "false" || t === "0" || t === "no" || t === "off") return false;
  }
  if (typeof x === "number") return x !== 0;
  return def;
}

function asNum(x: any, def: number): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

function asValidateModel(x: any, def: "light" | "heavy"): "light" | "heavy" {
  const t = String(x ?? "").trim().toLowerCase();
  if (t === "heavy") return "heavy";
  if (t === "light") return "light";
  return def;
}

function asFinalValidation(x: any, def: "off" | "light" | "heavy"): "off" | "light" | "heavy" {
  const t = String(x ?? "").trim().toLowerCase();
  if (t === "off" || t === "none") return "off";
  if (t === "light") return "light";
  if (t === "heavy") return "heavy";
  return def;
}

export function loadPlanner2Config(config: ConfigService): Planner2Config {
  const anyCfg = config?.data as any;

  const openaiCfg = anyCfg?.openai ?? {};
  const editCfg = anyCfg?.editPlanner ?? {}; // v2 lives here

  const traceCfg = editCfg?.trace ?? {};
  const modelsCfg = editCfg?.models ?? {};
  const parallelCfg = editCfg?.parallel ?? {};
  const ragCfg = editCfg?.rag ?? {};
  const segCfg = editCfg?.segmentation ?? {};
  const targetingCfg = editCfg?.targeting ?? {};
  const attemptsCfg = editCfg?.attempts ?? {};
  const guardsCfg = editCfg?.guards ?? {};
  const validationCfg = editCfg?.validation ?? {};

  const heavyFallback =
    String(openaiCfg?.chatModelHeavy ?? openaiCfg?.chatModel ?? openaiCfg?.model ?? "").trim() || "gpt-4o";
  const lightFallback =
    String(openaiCfg?.chatModelLight ?? openaiCfg?.chatModel ?? openaiCfg?.model ?? "").trim() || heavyFallback;
  const superHeavyFallback =
    String(openaiCfg?.chatModelSuperHeavy ?? openaiCfg?.chatModelHeavy ?? openaiCfg?.chatModel ?? openaiCfg?.model ?? "").trim() ||
    heavyFallback;

  const modelLight = String(modelsCfg?.modelLight ?? "").trim() || lightFallback;
  const modelHeavy = String(modelsCfg?.modelHeavy ?? "").trim() || heavyFallback;
  const modelSuperHeavy = String(modelsCfg?.modelSuperHeavy ?? "").trim() || superHeavyFallback;

  return {
    trace: { enabled: asBool(traceCfg?.enabled, false) },

    models: { modelLight, modelHeavy, modelSuperHeavy },

    parallel: {
      unitChanges: clampInt(parallelCfg?.unitChanges, 1, 32, 6),
      files: clampInt(parallelCfg?.files, 1, 32, 4)
    },

    rag: {
      enabled: asBool(ragCfg?.enabled, true),
      k: clampInt(ragCfg?.k, 1, 200, 12),
      metric: ragCfg?.metric ?? (anyCfg?.rag?.metric ?? "cosine")
    },

    segmentation: {
      newlineSnap: asBool(segCfg?.newlineSnap, true),
      newlineSnapWindow: clampInt(segCfg?.newlineSnapWindow, 0, 20000, 800),
      newlinePreferForward: asBool(segCfg?.newlinePreferForward, true),
      minFragmentChars: clampInt(segCfg?.minFragmentChars, 200, 60000, 900),
      maxFragmentChars: clampInt(segCfg?.maxFragmentChars, 1000, 200000, 12000),
      contextChars: clampInt(segCfg?.contextChars, 0, 20000, 900)
    },

    targeting: {
      useRagHits: asBool(targetingCfg?.useRagHits, true),
      maxCandidateFiles: clampInt(targetingCfg?.maxCandidateFiles, 5, 2000, 60),
      padBeforeChars: clampInt(targetingCfg?.padBeforeChars, 0, 200000, 600),
      padAfterChars: clampInt(targetingCfg?.padAfterChars, 0, 200000, 300),
      mergeGapChars: clampInt(targetingCfg?.mergeGapChars, 0, 200000, 200),
      maxWindowsPerUnit: clampInt(targetingCfg?.maxWindowsPerUnit, 1, 8, 1)
    },

    attempts: {
      maxRounds: clampInt(attemptsCfg?.maxRounds, 1, 10, 3),
      validateModel: asValidateModel(attemptsCfg?.validateModel, "light")
    },

    guards: {
      discardWhitespaceOnlyChanges: asBool(guardsCfg?.discardWhitespaceOnlyChanges, true),
      preserveLineEndings: asBool(guardsCfg?.preserveLineEndings, true),
      maxPatchCoverageWarn: Math.max(0, Math.min(1, asNum(guardsCfg?.maxPatchCoverageWarn, 0.5))),
      maxPatchCoverageError: Math.max(0, Math.min(1, asNum(guardsCfg?.maxPatchCoverageError, 0.85)))
    },

    validation: {
      final: asFinalValidation(validationCfg?.final, "heavy")
    }
  };
}
