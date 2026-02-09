import { OpenAIService } from "../../openai/openaiService";
import { ChangeDescription, PlannerConfig, UnitChange, UnitSplitOut } from "./commons";
import { PROMPT_UNIT_SPLIT } from "./prompts";
import { errMsg } from "./utils";
import type { PlannerTraceCollector } from "./trace";

function normalizeUnit(x: any, i: number): UnitChange {
  const id = String(x?.id ?? `unit_${i + 1}`).trim() || `unit_${i + 1}`;
  const title = String(x?.title ?? `Unit ${i + 1}`).trim() || `Unit ${i + 1}`;
  const instructions = String(x?.instructions).trim() || title;

  const pickArr = (v: any) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined);
...
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
  changeDescription: ChangeDescription;
  cfg: PlannerConfig;
  openai: OpenAIService;
  status: (s: string) => void;
  diag: string[];
  trace?: PlannerTraceCollector;
  files: Array<{ rel: string }>;
}): Promise<UnitChange[]> {
  const t0 = Date.now();
  const modelKind = "heavy";
  const prompt = String(params.changeDescription).trim();

  
  try {
    params.status("unitSplit (split): Splitting request into unit changes...");
    const out = await params.openai.language_request_with_JSON_out<UnitSplitOut>({
      modelKind,
      modelOverride: params.cfg.models.modelSuperHeavy,
      instructions: PROMPT_UNIT_SPLIT,
      input: [
        "\nAVAILABLE FILES",(params.files ?? []).map((f) => String(f?.rel ?? "").trim()).filter(Boolean).join("\t"),
        "\n...REQUEST BEGINS...\t",
        prompt,
        "\t...REQUEST ENDS...\n",
      ].join("\n"),
      maxRetries: 1
    });

        /* these need to be matched buy the schema suggested in PROMPT_CHANGE_DESCRIPTION */
    const us: UnitSplitOut = {
      summary: String((out as any)?.summary ?? "").trim(),
        units: (Array.isArray(o?.units) ? o.units : [])
    .map((x: any, i: number) => normalizeUnit(x, i))
    .filter((u: UnitChange) => (u.instructions ?? "").trim().length > 0),
    };


    if (!out.units?.length) throw "[splitIntoUnits] <filaure> Split engine produced zero UnitChange(s)";

    params.trace?.addStep("phaseA_unit_split", t0, Date.now(), {
      model: params.cfg.models.modelHeavy,
      unitCount: units.length,
      units: units.slice(0, 40).map((u: any) => ({ id: u.id, title: u.title, fileHints: u.fileHints, anchors: u.anchors }))
    });

    return units;
  } catch (e: any) {
    const msg = errMsg(e);
    params.diag.push(`[splitIntoUnits] Unit split failed: ${msg}`);
    params.trace?.addEvent("[splitIntoUnits] phaseA_unit_split_failed", { msg });

    return [{ id: "unit_1", title: "Change", instructions: params.changeDescription.description || String(params.prompt).trim() }];
  }
}
