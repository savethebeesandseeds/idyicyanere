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
