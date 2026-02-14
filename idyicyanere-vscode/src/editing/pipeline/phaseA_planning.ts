import { OpenAIService } from "../../openai/openaiService";
import { PlannerConfig, ResolvedMode } from "./tools/types";
import { ContextZero, ChangeDescription, ChangeDescription_schemaKeys } from "./prompts";
import { build_instructions_CHANGE_DESCRIPTION, build_input_CHANGE_DESCRIPTION } from "./prompts";
import { errMsg } from "./tools/utils";
import { ModeSession } from "./tools/modeSession";

export async function buildChangeDescription(params: {
  c0: ContextZero,  // prompt + files
  mode: ModeSession;
  cfg: PlannerConfig;
  openai: OpenAIService;
  status: (s: string) => void;
  prompt: string;
}): Promise<ChangeDescription> {
  const t0 = Date.now();
  const modelKind = "superHeavy";

  /* Execution is a simplied version, skips change step */
  if (params.mode.kind === "execute") {
    params.status("changeDescription (plan): skipped... (execute mode is on)");

    const out: ChangeDescription = {
      plan: params.prompt, // forward prompt
      notes: "Planning not required <skipped>",
    };
    
    params.mode.trace?.addStep("phaseA_change_description", t0, Date.now(), {
      status: "skipped",
      mode: params.mode.kind,
      input: params.prompt,
      instructions: "<none>",
      files: `[${(params.c0.files ?? []).map((f) => String(f?.rel ?? "").trim()).filter(Boolean).join(", ")}]`,
      output: {
        plan: out.plan,
        notes: out.notes
      }
    });

    return out;
  }
  
  /* Whole execution plan mode */
  try {
    params.status("changeDescription (plan): building detailed change description (modelSuperHeavy) …");
    
    const instructions: string = await build_instructions_CHANGE_DESCRIPTION(params.c0);
    const { input, trace_input } = await build_input_CHANGE_DESCRIPTION(params.c0);
    
    const out = await params.openai.language_request_with_TAGS_out<ChangeDescription>({
      modelKind,
      instructions,
      input,
      schemaKeys: ChangeDescription_schemaKeys,
      maxRetries: 2
    });

    params.mode.trace?.addStep("phaseA_change_description", t0, Date.now(), {
      status: "done",
      mode: params.mode.kind,
      model: String(modelKind),
      input: trace_input,
      instructions,
      output: {
        plan: out.plan,
        notes: out.notes
      }
    });

    return out;
  } catch (e: any) {
    const msg = errMsg(e);
    params.mode.diag?.push(`Change description failed: ${msg}`);
    params.mode.trace?.addEvent("phaseA_change_description_failed", { msg });

    throw("<phaseA_planning> failed...");
  }
}
