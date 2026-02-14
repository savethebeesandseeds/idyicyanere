// import { OpenAIService } from "../../openai/openaiService";
// import { IncludedFile, PlannerConfig, RagHit, RagStoreLike, ReadTextFileResult, UnitChange, UnitTarget } from "./commons";
// import {
//   clampInt,
//   normalizeRel,
//   segmentByChars,
//   tokenizeText
// } from "./utils";
// import type { PlannerTraceCollector } from "./trace";

// type ReadCached = (f: IncludedFile) => Promise<ReadTextFileResult>;

// function buildUnitQueryText(unit: UnitChange, userPrompt: string): string {
//   const bits: string[] = [];
//   bits.push(userPrompt);
//   bits.push(`UNIT: ${unit.title}`);
//   bits.push(unit.instructions);
//   if (unit.fileHints?.length) bits.push(`fileHints: ${unit.fileHints.join(", ")}`);
//   if (unit.anchors?.length) bits.push(`anchors: ${unit.anchors.join(", ")}`);
//   if (unit.acceptanceCriteria?.length) bits.push(`accept: ${unit.acceptanceCriteria.join(" | ")}`);
//   return bits.filter(Boolean).join("\n");
// }

// function pickFragmentSize(cfg: PlannerConfig, f: IncludedFile): number {
//   const hinted = Math.trunc(Number(f.chunkChars ?? 0)) || cfg.segmentation.maxFragmentChars;
//   return Math.max(cfg.segmentation.minFragmentChars, Math.min(cfg.segmentation.maxFragmentChars, hinted));
// }

// function scoreRelByTokens(rel: string, tokens: string[], fileHints?: string[]): number {
//   const relL = normalizeRel(rel).toLowerCase();
//   let score = 0;

//   for (const h of fileHints ?? []) {
//     const hh = String(h ?? "").trim().toLowerCase();
//     if (!hh) continue;
//     if (relL.includes(hh)) score += 6;
//   }

//   for (const t of tokens) {
//     if (t && relL.includes(t)) score += 1;
//   }

//   if (score > 0 && (relL.includes("/src/") || relL.startsWith("src/"))) score += 0.5;
//   return score;
// }

// function relMatchesAnyHint(rel: string, fileHints?: string[]): boolean {
//   const relL = normalizeRel(rel).toLowerCase();
//   const hints = (fileHints ?? []).map((h) => String(h ?? "").trim().toLowerCase()).filter(Boolean);
//   if (!hints.length) return true;
//   return hints.some((h) => relL.includes(h));
// }

// function scoreSegmentByTokens(seg: string, tokens: string[]): number {
//   const s = String(seg ?? "").toLowerCase();
//   let score = 0;
//   for (const t of tokens) if (t && s.includes(t)) score++;
//   return score;
// }

// function clampRange(start: number, end: number, len: number): { start: number; end: number } {
//   let s = Math.trunc(Number(start));
//   let e = Math.trunc(Number(end));
//   if (!Number.isFinite(s)) s = 0;
//   if (!Number.isFinite(e)) e = 0;
//   s = Math.max(0, Math.min(len, s));
//   e = Math.max(0, Math.min(len, e));
//   if (e < s) [s, e] = [e, s];
//   return { start: s, end: e };
// }

// function snapStartToNewline(text: string, start: number, window: number): number {
//   if (window <= 0) return start;
//   const lo = Math.max(0, start - window);
//   for (let i = start - 1; i >= lo; i--) if (text.charCodeAt(i) === 10) return i + 1;
//   return start;
// }

// function snapEndToNewline(text: string, end: number, window: number): number {
//   if (window <= 0) return end;
//   const hi = Math.min(text.length, end + window);
//   for (let i = end; i < hi; i++) if (text.charCodeAt(i) === 10) return i + 1;
//   return end;
// }

// function padAndSnapRegion(cfg: PlannerConfig, text: string, start: number, end: number): { start: number; end: number } {
//   const len = text.length;

//   const padBefore = Math.max(0, cfg.targeting.padBeforeChars);
//   const padAfter = Math.max(0, cfg.targeting.padAfterChars);

//   let s = Math.max(0, Math.trunc(start) - padBefore);
//   let e = Math.min(len, Math.trunc(end) + padAfter);

//   if (cfg.segmentation.newlineSnap) {
//     const w = Math.max(0, cfg.segmentation.newlineSnapWindow);
//     s = snapStartToNewline(text, s, w);
//     e = snapEndToNewline(text, e, w);
//   }

//   if (e <= s) e = Math.min(len, s + 1);
//   return { start: s, end: e };
// }

// export async function pickTargetForUnit(params: {
//   cfg: PlannerConfig;
//   unit: UnitChange;
//   userPrompt: string;
//   files: IncludedFile[];
//   relToIndex: Map<string, number>;
//   readCached: ReadCached;
//   ragStore?: RagStoreLike;
//   openai: OpenAIService;
//   trace?: PlannerTraceCollector;
// }): Promise<{ target: UnitTarget | null; fileText?: string }> {
//   const { cfg, unit, files, relToIndex, readCached, ragStore, openai } = params;
//   const unitText = buildUnitQueryText(unit, params.userPrompt);

//   // If fileHints match at least one provided file, restrict search to those files.
//   const hintMatchedFiles = (unit.fileHints?.length
//     ? files.filter((f) => relMatchesAnyHint(f.rel, unit.fileHints))
//     : []);
//   const restrictByHints = unit.fileHints?.length ? hintMatchedFiles.length > 0 : false;
//   const filesForSearch = restrictByHints ? hintMatchedFiles : files;

//   // ---- Preferred: RAG hits -> (file,start,end) ----
//   if (cfg.rag.enabled && cfg.targeting.useRagHits && ragStore && typeof ragStore.queryHits === "function") {
//     try {
//       const [qVec] = await openai.embedTexts([unitText]);
//       const hits: RagHit[] = await ragStore.queryHits(qVec, cfg.rag.k, cfg.rag.metric);

//       const sorted = (Array.isArray(hits) ? hits : []).slice().sort((a, b) => (Number(b?.score ?? 0) - Number(a?.score ?? 0)));

//       for (const h of sorted) {
//         const relN = normalizeRel(String(h?.rel ?? ""));
//         if (!relN) continue;

//         if (restrictByHints && !relMatchesAnyHint(relN, unit.fileHints)) continue;

//         const idx = relToIndex.get(relN);
//         if (typeof idx !== "number") continue;

//         const f = files[idx];
//         const read = await readCached(f);
//         if (!read.ok) continue;

//         const base = clampRange(Number(h.start ?? 0), Number(h.end ?? 0), read.text.length);
//         if (base.end <= base.start) continue;

//         const padded = padAndSnapRegion(cfg, read.text, base.start, base.end);

//         // enforce fragment size cap
//         const fragMax = pickFragmentSize(cfg, f);
//         let start = padded.start;
//         let end = padded.end;
//         if (end - start > fragMax) {
//           const mid = Math.trunc((base.start + base.end) / 2);
//           start = Math.max(0, mid - Math.trunc(fragMax / 2));
//           end = Math.min(read.text.length, start + fragMax);

//           if (cfg.segmentation.newlineSnap) {
//             start = snapStartToNewline(read.text, start, cfg.segmentation.newlineSnapWindow);
//             end = snapEndToNewline(read.text, end, cfg.segmentation.newlineSnapWindow);
//           }
//         }

//         return {
//           target: {
//             unitId: unit.id,
//             rel: relN,
//             uri: f.uri.toString(),
//             start,
//             end,
//             why: `rag hit score=${Number(h.score ?? 0)}`,
//             score: Number(h.score ?? 0)
//           },
//           fileText: read.text
//         };
//       }
//     } catch (e: any) {
//       params.trace?.addEvent("unit_target_rag_failed", { unitId: unit.id, msg: String(e?.message ?? e) });
//       // fall through
//     }
//   }

//   // ---- Fallback: heuristic shortlist + segment scoring ----
//   const tokens = tokenizeText(
//     [
//       unit.title,
//       unit.instructions,
//       (unit.fileHints ?? []).join(" "),
//       (unit.anchors ?? []).join(" "),
//       (unit.acceptanceCriteria ?? []).join(" "),
//       params.userPrompt
//     ].join("\n"),
//     48
//   );

//   const maxCand = Math.max(5, clampInt(cfg.targeting.maxCandidateFiles, 5, 2000, 60));

//   const scoredFiles = filesForSearch
//     .map((f, i) => ({ f, i, score: scoreRelByTokens(f.rel, tokens, unit.fileHints) }))
//     .sort((a, b) => (b.score - a.score) || a.f.rel.localeCompare(b.f.rel))
//     .slice(0, Math.max(1, Math.min(maxCand, files.length)));

//   let best: { idx: number; rel: string; uri: string; start: number; end: number; why: string; score: number; fileText: string } | null = null;

//   for (const cand of scoredFiles) {
//     const read = await readCached(cand.f);
//     if (!read.ok) continue;

//     const fragSize = pickFragmentSize(cfg, cand.f);

//     const segs = segmentByChars(read.text, fragSize, {
//       snapToNewline: cfg.segmentation.newlineSnap,
//       newlineWindow: cfg.segmentation.newlineSnapWindow,
//       preferForward: cfg.segmentation.newlinePreferForward,
//       minChunkChars: cfg.segmentation.minFragmentChars,
//       maxChunkChars: cfg.segmentation.maxFragmentChars
//     });

//     let bestSeg = segs[0];
//     let bestScore = -1;

//     for (const s of segs) {
//       const sc = scoreSegmentByTokens(s.seg, tokens);
//       if (sc > bestScore) {
//         bestScore = sc;
//         bestSeg = s;
//       }
//     }

//     const candidate = {
//       idx: cand.i,
//       rel: normalizeRel(cand.f.rel),
//       uri: cand.f.uri.toString(),
//       start: bestSeg.start,
//       end: bestSeg.end,
//       why: bestScore > 0 ? `segment token score=${bestScore}` : "fallback first segment",
//       score: bestScore,
//       fileText: read.text
//     };

//     if (!best || candidate.score > best.score) best = candidate;
//   }

//   if (!best) return { target: null };

//   return {
//     target: {
//       unitId: unit.id,
//       rel: best.rel,
//       uri: best.uri,
//       start: best.start,
//       end: best.end,
//       why: best.why,
//       score: best.score
//     },
//     fileText: best.fileText
//   };
// }
