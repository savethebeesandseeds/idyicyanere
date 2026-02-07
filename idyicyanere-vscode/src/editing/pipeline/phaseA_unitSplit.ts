// src/editing/pipeline2/phaseA_unitSplit.ts
import { OpenAIService } from "../../openai/openaiService";
import { ChangeDescription, Planner2Config, UnitChange, UnitSplitOut } from "./commons";
import { PROMPT_UNIT_SPLIT } from "./prompts";
import { errMsg } from "./utils";
import type { PlannerTraceCollector } from "./trace";

function normalizeUnit(x: any, i: number): UnitChange {
  const id = String(x?.id ?? `unit_${i + 1}`).trim() || `unit_${i + 1}`;
  const title = String(x?.title ?? `Unit ${i + 1}`).trim() || `Unit ${i + 1}`;
  const instructions = String(x?.instructions ?? "").trim() || title;

  const pickArr = (v: any) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined);

  return {
    id,
    title,
    instructions,
    fileHints: pickArr(x?.fileHints),
    anchors: pickArr(x?.anchors),
    acceptanceCriteria: pickArr(x?.acceptanceCriteria)
  };
}

export async function splitIntoUnits(params: {
  prompt: string;
  changeDescription: ChangeDescription;
  cfg: Planner2Config;
  openai: OpenAIService;
  status: (s: string) => void;
  diag: string[];
  trace?: PlannerTraceCollector;
  files: Array<{ rel: string }>;
}): Promise<UnitChange[]> {
  const t0 = Date.now();

  try {
    params.status("Splitting into unit changes (modelHeavy) …");

    const input = [
      "AVAILABLE FILES (relative paths; unless otherwise specified scope is LIMITED to these):",
      (params.files ?? [])
        .map((f) => String(f?.rel ?? "").trim())
        .filter(Boolean)
        .map((r) => `- ${r}`)
        .join("\n") || "(none)",
      "",
      "USER PROMPT:",
      String(params.prompt ?? "").trim(),
      "",
      "CHANGE DESCRIPTION:",
      JSON.stringify(params.changeDescription ?? {}, null, 2)
    ].join("\n");

    const out = await params.openai.completeJson<UnitSplitOut>({
      modelKind: "heavy",
      modelOverride: params.cfg.models.modelHeavy,
      instructions: PROMPT_UNIT_SPLIT,
      input,
      maxRetries: 1
    });

    const raw = Array.isArray((out as any)?.units) ? (out as any).units : [];
    const units = raw.map((x: any, i: number) => normalizeUnit(x, i)).filter((u: UnitChange) => !!u.instructions).slice(0, 30);

    const finalUnits =
      units.length
        ? units
        : [{ id: "unit_1", title: "Change", instructions: params.changeDescription.description || String(params.prompt ?? "").trim() }];

    params.trace?.addStep("phaseA_unit_split", t0, Date.now(), {
      model: params.cfg.models.modelHeavy,
      unitCount: finalUnits.length,
      units: finalUnits.slice(0, 40).map((u: any) => ({ id: u.id, title: u.title, fileHints: u.fileHints, anchors: u.anchors }))
    });

    return finalUnits;
  } catch (e: any) {
    const msg = errMsg(e);
    params.diag.push(`Unit split failed: ${msg}`);
    params.trace?.addEvent("phaseA_unit_split_failed", { msg });

    return [{ id: "unit_1", title: "Change", instructions: params.changeDescription.description || String(params.prompt ?? "").trim() }];
  }
}
