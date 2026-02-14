// src/editing/pipeline/tools/unidiff.ts
// Pure helpers: no vscode/fs. Safe for unit tests.

export type UnifiedDiffIssue = {
  severity: "warn" | "error";
  message: string;
  atLine?: number;     // 1-based line in baseline file (when applicable)
  expected?: string;
  found?: string;
  context?: string;    // line-numbered snippet near failure
  code?: string;       // short machine hint
};

export type ApplyUnifiedDiffResult = {
  ok: boolean;
  afterText?: string;
  issues: UnifiedDiffIssue[];
};

// ---------- line endings ----------
export type LineEnding = "lf" | "crlf";

export function detectDominantLineEnding(text: string): LineEnding {
  const s = String(text ?? "");
  const lfTotal = (s.match(/\n/g) ?? []).length;
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lfOnly = Math.max(0, lfTotal - crlf);
  return crlf >= lfOnly && crlf > 0 ? "crlf" : "lf";
}

export function convertLineEndings(text: string, target: LineEnding): string {
  const norm = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return target === "lf" ? norm : norm.replace(/\n/g, "\r\n");
}

function normalizeToLF(text: string): string {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ---------- line numbering ----------
export function formatWithLineNumbers(
  text: string,
  opts?: {
    minPad?: number;           // default 4
    maxLines?: number;         // if exceeded, we truncate (default 5000)
    headLines?: number;        // default 250
    tailLines?: number;        // default 250
  }
): { numbered: string; totalLines: number; truncated: boolean } {
  const lf = normalizeToLF(text);
  const lines = lf.split("\n");
  const totalLines = lines.length;
  const minPad = Math.max(1, Math.trunc(opts?.minPad ?? 4));
  const pad = Math.max(minPad, String(totalLines).length);

  const maxLines = Math.max(50, Math.trunc(opts?.maxLines ?? 5000));
  const headLines = Math.max(10, Math.trunc(opts?.headLines ?? 250));
  const tailLines = Math.max(10, Math.trunc(opts?.tailLines ?? 250));

  const fmtLine = (n: number, s: string) => `${String(n).padStart(pad, "0")}|${s}`;

  if (totalLines <= maxLines) {
    return {
      numbered: lines.map((s, i) => fmtLine(i + 1, s)).join("\n"),
      totalLines,
      truncated: false
    };
  }

  const head = lines.slice(0, headLines);
  const tail = lines.slice(Math.max(headLines, totalLines - tailLines));

  const midOmitted = totalLines - head.length - tail.length;

  const out: string[] = [];
  for (let i = 0; i < head.length; i++) out.push(fmtLine(i + 1, head[i]));
  out.push(`${"".padStart(pad, "0")}|... <TRUNCATED ${midOmitted} line(s)> ...`);
  for (let i = 0; i < tail.length; i++) {
    const lineNo = totalLines - tail.length + i + 1;
    out.push(fmtLine(lineNo, tail[i]));
  }

  return { numbered: out.join("\n"), totalLines, truncated: true };
}

function snippetWithLineNumbers(lines: string[], at0: number, radius = 3): string {
  const lo = Math.max(0, at0 - radius);
  const hi = Math.min(lines.length - 1, at0 + radius);
  const pad = Math.max(4, String(lines.length).length);

  const out: string[] = [];
  for (let i = lo; i <= hi; i++) {
    out.push(`${String(i + 1).padStart(pad, "0")}|${lines[i]}`);
  }
  return out.join("\n");
}

// ---------- unified diff parsing/apply ----------
type Hunk = {
  oldStart: number; oldCount: number;
  newStart: number; newCount: number;
  lines: string[]; // includes prefix ' ', '+', '-', '\' meta
};

function parseHunks(diffLF: string): { hunks: Hunk[]; issues: UnifiedDiffIssue[] } {
  const lines = diffLF.split("\n");
  const issues: UnifiedDiffIssue[] = [];

  const hunks: Hunk[] = [];
  let i = 0;

  // Skip headers until first @@
  while (i < lines.length && !lines[i].startsWith("@@")) i++;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("@@")) { i++; continue; }

    const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!m) {
      issues.push({ severity: "error", message: `Bad hunk header: ${line}`, code: "bad_hunk_header" });
      i++;
      continue;
    }

    const oldStart = Number(m[1]);
    const oldCount = m[2] ? Number(m[2]) : 1;
    const newStart = Number(m[3]);
    const newCount = m[4] ? Number(m[4]) : 1;

    i++;
    const hunkLines: string[] = [];
    while (i < lines.length && !lines[i].startsWith("@@")) {
      hunkLines.push(lines[i]);
      i++;
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
  }

  if (hunks.length === 0) {
    issues.push({
      severity: "error",
      message: "No @@ hunks found in diff (not a unified diff, or missing hunks).",
      code: "no_hunks"
    });
  }

  return { hunks, issues };
}

function trimEdgeNewlinesOnly(s: string): string {
  let t = String(s ?? "");
  while (t.startsWith("\n") || t.startsWith("\r")) t = t.slice(1);
  while (t.endsWith("\n") || t.endsWith("\r")) t = t.slice(0, -1);
  return t;
}

export function tryApplyUnifiedDiff(params: {
  rel: string;
  oldText: string;
  diff: string;
}): ApplyUnifiedDiffResult {
  const rel = String(params.rel ?? "").trim();
  const oldText = String(params.oldText ?? "");
  const diffRaw = String(params.diff ?? "");

  if (!diffRaw.trim()) {
    return {
      ok: false,
      issues: [{ severity: "error", message: "Empty diff.", code: "empty_diff" }]
    };
  }

  const fileLE = detectDominantLineEnding(oldText);

  const oldLF = normalizeToLF(oldText);
  const diffLF = normalizeToLF(trimEdgeNewlinesOnly(diffRaw));

  const oldLines = oldLF.split("\n");
  const { hunks, issues: parseIssues } = parseHunks(diffLF);
  if (parseIssues.length) return { ok: false, issues: parseIssues };

  const outLines: string[] = [];
  let origPos = 0;

  for (const h of hunks) {
    const targetPos = Math.max(0, h.oldStart - 1);

    if (targetPos < origPos) {
      return {
        ok: false,
        issues: [{
          severity: "error",
          message: `Overlapping/out-of-order hunks (hunk oldStart=${h.oldStart} < current=${origPos + 1}).`,
          code: "hunks_out_of_order"
        }]
      };
    }

    // Copy unchanged lines before the hunk start
    outLines.push(...oldLines.slice(origPos, targetPos));
    origPos = targetPos;

    for (const rawLine of h.lines) {
      if (!rawLine) {
        // empty line is valid; it will be treated by prefix rules below
      }

      const prefix = rawLine[0];
      const content = rawLine.slice(1);

      if (rawLine.startsWith("\\ No newline at end of file")) {
        // ignore meta
        continue;
      }

      if (prefix === " ") {
        const found = oldLines[origPos] ?? "";
        if (found !== content) {
          const atLine = origPos + 1;
          return {
            ok: false,
            issues: [{
              severity: "error",
              message: `Context mismatch at ${rel}:${atLine}.`,
              atLine,
              expected: content,
              found,
              context: snippetWithLineNumbers(oldLines, origPos, 3),
              code: "context_mismatch"
            }]
          };
        }
        outLines.push(found);
        origPos++;
        continue;
      }

      if (prefix === "-") {
        const found = oldLines[origPos] ?? "";
        if (found !== content) {
          const atLine = origPos + 1;
          return {
            ok: false,
            issues: [{
              severity: "error",
              message: `Deletion mismatch at ${rel}:${atLine}.`,
              atLine,
              expected: content,
              found,
              context: snippetWithLineNumbers(oldLines, origPos, 3),
              code: "delete_mismatch"
            }]
          };
        }
        origPos++;
        continue;
      }

      if (prefix === "+") {
        outLines.push(content);
        continue;
      }

      // If the line doesn't start with expected prefixes, it's malformed
      return {
        ok: false,
        issues: [{
          severity: "error",
          message: `Malformed hunk line (must start with ' ', '+', '-', or '\\\\'): ${JSON.stringify(rawLine)}`,
          code: "bad_hunk_line"
        }]
      };
    }
  }

  // Copy remainder
  outLines.push(...oldLines.slice(origPos));

  const afterLF = outLines.join("\n");
  const after = convertLineEndings(afterLF, fileLE);

  return { ok: true, afterText: after, issues: [] };
}

export function renderUnifiedDiffIssues(issues: UnifiedDiffIssue[]): string {
  const xs = (issues ?? []).slice(0, 6);
  return xs.map((x, i) => {
    const parts: string[] = [];
    parts.push(`#${i + 1} ${x.severity.toUpperCase()}: ${x.message}`);
    if (x.atLine != null) parts.push(`atLine=${x.atLine}`);
    if (typeof x.expected === "string") parts.push(`expected=${JSON.stringify(x.expected)}`);
    if (typeof x.found === "string") parts.push(`found=${JSON.stringify(x.found)}`);
    if (x.code) parts.push(`code=${x.code}`);
    if (x.context) parts.push(`context:\n${x.context}`);
    return parts.join("\n");
  }).join("\n\n");
}
