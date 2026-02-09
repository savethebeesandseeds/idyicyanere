import { OpenAIService } from "../../openai/openaiService";
import { PlannerConfig } from "./tools/types";
import { ChangeDescription } from "./prompts";
import { build_instructions_CHANGE_DESCRIPTION, build_input_CHANGE_DESCRIPTION } from "./prompts";
import { errMsg, ResolvedMode } from "./utils";
import type { PlannerTraceCollector } from "./trace";

export async function buildChangeDescription(params: {
  mode: ResolvedMode;
  prompt: string;
  cfg: PlannerConfig;
  openai: OpenAIService;
  status: (s: string) => void;
  diag: string[];
  trace?: PlannerTraceCollector;
  files: Array<{ rel: string; uri: string }>;
}): Promise<ChangeDescription> {
  const t0 = Date.now();
  const modelKind = "superHeavy";

  /* Execution is a simplied version, skips change step */
  if (params.mode === "execute") {
    params.status("changeDescription (plan): skipped... (execute mode is on)");

    const cd: ChangeDescription = {
      result: params.prompt, // forward prompt
      assumptions: ["Planning not required <skipped>"],
      notes: [],
    };
    
    params.trace?.addStep("phaseA_change_description", t0, Date.now(), {
      status: "skipped",
      mode: params.mode,
      prompt: params.prompt,
      files: `[${(params.files ?? []).map((f) => String(f?.rel ?? "").trim()).filter(Boolean).join(", ")}]`,
      output: {
        result: cd.result,
        assumptions: cd.assumptions,
        notes: cd.notes
      }
    });

    return cd;
  }
  
  /* Whole execution plan mode */
  try {
    params.status("changeDescription (plan): building detailed change description (modelSuperHeavy) …");
    
    const instructions: string = await build_instructions_CHANGE_DESCRIPTION({});
    const input: string = await build_input_CHANGE_DESCRIPTION({prompt: params.prompt, files: params.files});
    
    const cd = await params.openai.language_request_with_JSON_out<ChangeDescription>({
      modelKind,
      instructions,
      input,
      maxRetries: 2
    });

    params.trace?.addStep("phaseA_change_description", t0, Date.now(), {
      status: "done",
      mode: params.mode,
      model: String(modelKind),
      prompt: `<FILE CONTETS added>, prompt: ${params.prompt}`,
      files: `[${(params.files).map((f) => String(f?.rel ?? "").trim()).filter(Boolean).join(",")}]`,
      output: {
        result: cd.result,
        assumptions: cd.assumptions,
        notes: cd.notes
      }
    });

    return cd;
  } catch (e: any) {
    const msg = errMsg(e);
    params.diag.push(`Change description failed: ${msg}`);
    params.trace?.addEvent("phaseA_change_description_failed", { msg });

    throw("<phaseA_planning> failed...");
  }
}
