// src/editing/pipeline/tools/modeSession.ts
import type { PlannerTraceCollector } from "./trace";
import type { ResolvedMode } from "./types";

export type ModePhase =
  | "pipeline"
  | "phaseA"
  | "phaseB"
  | "phaseB.5"
  | "phaseC"
  | string;

export type ModeIssue = {
  severity: "warn" | "error";
  message: string;
  code?: string;
};

export type ModeValidation = {
  phase: ModePhase;
  ok: boolean;
  issues: ModeIssue[];
  atMs: number;
};

function safePush(arr: string[] | undefined, s: string): void {
  try {
    if (!arr) return;
    arr.push(s);
  } catch {
    // ignore
  }
}

function summarizeIssues(issues: ModeIssue[]): string {
  const e = issues.filter((x) => x.severity === "error").length;
  const w = issues.filter((x) => x.severity === "warn").length;
  const parts: string[] = [];
  if (e) parts.push(`${e} error(s)`);
  if (w) parts.push(`${w} warn(s)`);
  return parts.join(", ") || "ok";
}

export class ModeSession {
  readonly kind: ResolvedMode;

  // ✅ expose trace directly, no wrapper methods
  readonly trace?: PlannerTraceCollector;
  readonly diag?: string[];

  private readonly promptNotes = new Map<ModePhase, string[]>();
  readonly validations: ModeValidation[] = [];

  constructor(params: { kind: ResolvedMode; trace?: PlannerTraceCollector; diag?: string[] }) {
    this.kind = params.kind;
    this.trace = params.trace;
    this.diag = params.diag;
  }

  addPromptNote(phase: ModePhase, note: string): void {
    const p = String(phase ?? "").trim() || "pipeline";
    const n = String(note ?? "").trim();
    if (!n) return;

    if (!this.promptNotes.has(p)) this.promptNotes.set(p, []);
    this.promptNotes.get(p)!.push(n);
  }

  getPromptNotes(phase: ModePhase): string[] {
    const p = String(phase ?? "").trim() || "pipeline";
    return (this.promptNotes.get(p) ?? []).slice();
  }

  withPromptNotes(phase: ModePhase, base: string): string {
    const notes = this.getPromptNotes(phase);
    if (!notes.length) return String(base ?? "");

    return [
      String(base ?? "").trimEnd(),
      "",
      "MODE NOTES (from validations / previous attempts):",
      ...notes.map((x) => `- ${x}`)
    ].join("\n");
  }

  /**
   * Runs a validation function and records:
   * - this.validations
   * - trace event "mode_validation"
   * - prompt note if failed
   */
  validate(phase: ModePhase, fn: () => ModeIssue[] | void): ModeValidation {
    const p = String(phase ?? "").trim() || "pipeline";
    const atMs = Date.now();

    let issues: ModeIssue[] = [];
    try {
      const out = fn();
      if (Array.isArray(out)) issues = out;
    } catch (e: any) {
      issues = [{
        severity: "error",
        message: `Validation threw: ${String(e?.message ?? e)}`,
        code: "validation_threw"
      }];
    }

    const ok = !issues.some((x) => x.severity === "error");
    const v: ModeValidation = { phase: p, ok, issues, atMs };
    this.validations.push(v);

    // best-effort trace
    try {
      this.trace?.addEvent?.("mode_validation", {
        phase: p,
        ok,
        issueCount: issues.length,
        issues
      });
    } catch (e: any) {
      safePush(this.diag, `[mode] trace.addEvent failed: ${String(e?.message ?? e)}`);
    }

    if (!ok) {
      const short = issues
        .filter((x) => x.severity === "error")
        .slice(0, 6)
        .map((x) => (x.code ? `${x.code}: ${x.message}` : x.message))
        .join(" | ");

      this.addPromptNote(p, `Validation failed (${summarizeIssues(issues)}): ${short}`);
    }

    return v;
  }
}
