export type StatusKind = "not_indexed" | "indexed" | "stale" | "indexing" | "hidden" | "error";
export type NodeKind = "root" | "folder" | "file";

export type NodeRow = {
  kind: NodeKind;
  uri: string;
  name: string;
  rel: string;

  // status can apply to files OR containers (aggregated recursive status)
  status?: StatusKind;
  sizeBytes?: number;
  ext?: string;
  chunking?: string;
};

export type WebviewIn =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "getChildren"; uri: string }
  | { type: "search"; query: string; limit?: number } 
  | { type: "open"; uri: string }
  | { type: "indexFile"; uri: string }
  | { type: "reindexFile"; uri: string }
  | { type: "setHidden"; uri: string; hidden: boolean }
  | { type: "folderBatch"; uri: string; wantIndex: boolean }
  | { type: "clientError"; text: string; stack?: string };

export type WebviewOut =
  | { type: "roots"; rows: NodeRow[] }
  | { type: "children"; parent: string; rows: NodeRow[] }
  | { type: "status"; text: string }
  | { type: "error"; text: string };