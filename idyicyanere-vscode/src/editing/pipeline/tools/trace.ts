import { previewHeadTail } from "./utils";

export type PlannerTraceStep = {
  name: string;
  startedAtMs: number;
  endedAtMs: number;
  dtMs: number;
  data?: any;
};

export type PlannerTraceEvent = {
  name: string;
  atMs: number;
  data?: any;
};

export type PlannerTrace = {
  version: 2;
  id: string;
  createdAtMs: number;

  prompt: string;
  mode: string;

  cfg: any;
  inputFiles: Array<{ rel: string; uri: string; chunkChars: number }>;

  steps: PlannerTraceStep[];
  events: PlannerTraceEvent[];

  final?: any;
};

type PruneOpts = {
  maxStringChars: number;
  maxArray: number;
  maxKeys: number;
  maxDepth: number;
};

function truncate(s: string, max: number): string {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}… [truncated ${t.length - max} chars]`;
}

function pruneAny(value: any, opts: PruneOpts, depth: number, seen: WeakSet<object>): any {
  if (value == null) return value;

  const ty = typeof value;
  if (ty === "string") return truncate(value, opts.maxStringChars);
  if (ty === "number" || ty === "boolean") return value;
  if (ty === "bigint") return value.toString();
  if (ty === "function") return "[function]";

  if (Array.isArray(value)) {
    if (depth <= 0) return `[array(${value.length})]`;
    const lim = Math.min(value.length, opts.maxArray);
    const out = new Array(lim);
    for (let i = 0; i < lim; i++) out[i] = pruneAny(value[i], opts, depth - 1, seen);
    if (value.length > lim) out.push({ __truncated: true, total: value.length });
    return out;
  }

  if (ty === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (depth <= 0) return "[object]";

    const keys = Object.keys(value);
    const lim = Math.min(keys.length, opts.maxKeys);
    const out: any = {};
    for (let i = 0; i < lim; i++) {
      const k = keys[i];
      out[k] = pruneAny((value as any)[k], opts, depth - 1, seen);
    }
    if (keys.length > lim) out.__truncatedKeys = { total: keys.length };
    return out;
  }

  return truncate(String(value), opts.maxStringChars);
}

function pruneRoot(value: any, opts: PruneOpts): any {
  return pruneAny(value, opts, opts.maxDepth, new WeakSet<object>());
}

export class PlannerTraceCollector {
  readonly trace: PlannerTrace;
  private readonly opts: PruneOpts;

  constructor(init: {
    prompt: string;
    mode: string;
    cfg: any;
    inputFiles: Array<{ rel: string; uri: string; chunkChars: number }>;
  }) {
    this.opts = { maxStringChars: 24_000, maxArray: 600, maxKeys: 300, maxDepth: 8 };

    const createdAtMs = Date.now();
    const id = `reason_${createdAtMs}_${Math.random().toString(16).slice(2, 10)}`;

    this.trace = {
      version: 2,
      id,
      createdAtMs,
      prompt: truncate(String(init.prompt ?? ""), 120_000),
      mode: String(init.mode ?? ""),
      cfg: pruneRoot(init.cfg ?? {}, this.opts),
      inputFiles: pruneRoot(init.inputFiles ?? [], this.opts),
      steps: [],
      events: []
    };
  }

  addStep(name: string, startedAtMs: number, endedAtMs: number, data?: any) {
    const st = Math.trunc(Number(startedAtMs));
    const en = Math.trunc(Number(endedAtMs));
    const dt = Math.max(0, en - st);

    this.trace.steps.push({
      name: String(name ?? "step"),
      startedAtMs: st || Date.now(),
      endedAtMs: en || Date.now(),
      dtMs: dt,
      data: data == null ? undefined : pruneRoot(data, this.opts)
    });
  }

  addEvent(name: string, data?: any) {
    this.trace.events.push({
      name: String(name ?? "event"),
      atMs: Date.now(),
      data: data == null ? undefined : pruneRoot(data, this.opts)
    });
  }

  setFinal(data: any) {
    this.trace.final = pruneRoot(data, this.opts);
  }

  // Convenience for big text blocks (store head/tail only)
  preview(text: string, head = 2000, tail = 800) {
    return previewHeadTail(text, head, tail);
  }
}
