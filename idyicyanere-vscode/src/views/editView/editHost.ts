import { EditState, RunRecord } from "./editState";
import { WebviewOut } from "./editTypes";
import type { PlannerTraceCollector } from "../../editing/pipeline/tools/trace";

export type EditHost = {
  getState(): EditState;
  setState(next: EditState): void;

  ui(payload: WebviewOut, where?: string): void;
  withBusy(where: string, statusText: string, fn: () => Promise<void>): Promise<void>;

  scheduleSave(): void;
  sendState(): Promise<void>;

  getActiveRun(): RunRecord | null;
  ensure_index(): Promise<void>;

  getTrace?: () => PlannerTraceCollector | undefined;
};
