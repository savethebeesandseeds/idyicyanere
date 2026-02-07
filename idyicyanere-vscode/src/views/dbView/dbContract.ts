import { RagMetric } from "../../storage/configService";

export type WebviewIn =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "fix" }
  | { type: "openConfig" }
  | { type: "setApiKey" }
  | { type: "clientError"; text: string; stack?: string }
  | { type: "openFile"; uri: string }
  | { type: "reindexFile"; uri: string }
  | { type: "setHidden"; uri: string; hidden: boolean }
  | { type: "purgeFile"; uri: string }
  | { type: "query"; text: string; k?: number; maxChars?: number; metric?: RagMetric };

export type DbFileRow = {
  uri: string;
  rel: string;
  rows: number;
  mtimeMs: number;
  stale: boolean;
  missing: boolean;
  hidden: boolean;
};

export type QueryHit = {
  index: number;
  rel?: string;
  uri?: string;
  chunking?: string;
  text: string;
};

export type QueryResultPayload = {
  question: string;
  params: { k: number; maxChars: number; metric: RagMetric };
  truncated: boolean;
  hits: QueryHit[];
  rawContext: string;
};

export type DbStatsPayload = {
  dbPath: string;
  dbExists: boolean;
  dbSizeBytes: number | null;
  dbMtimeMs: number | null;
  nextRow: number | null;

  embeddingModel: string;
  chatModel: string;
  rag: { k: number; maxChars: number; metric: RagMetric };

  totalFiles: number;
  includedFiles: number;
  hiddenFiles: number;

  trackedRowsAll: number;
  trackedRowsIncluded: number;
  uniqueRowsAll: number;
  uniqueRowsIncluded: number;

  files: DbFileRow[];
};

export type WebviewOut =
  | { type: "status"; text: string }
  | { type: "stats"; stats: DbStatsPayload; text?: string } // text is optional; webview JS already probes msg.text
  | { type: "queryResult"; payload: QueryResultPayload }
  | { type: "error"; text: string };
