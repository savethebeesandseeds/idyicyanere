// src/editing/pipeline2/phaseA_changeDescription.ts
import { OpenAIService } from "../../openai/openaiService";
import { ChangeDescription, Planner2Config } from "./commons";
import { PROMPT_CHANGE_DESCRIPTION } from "./prompts";
import { errMsg, previewHeadTail, ResolvedMode } from "./utils";
import type { PlannerTraceCollector } from "./trace";

export async function buildChangeDescription(params: {
  mode: ResolvedMode;
  prompt: string;
  cfg: Planner2Config;
  openai: OpenAIService;
  status: (s: string) => void;
  diag: string[];
  trace?: PlannerTraceCollector;
  files: Array<{ rel: string }>;
}): Promise<ChangeDescription> {
  const prompt = String(params.prompt ?? "").trim();

  // execute: skip super heavy call
  if (params.mode === "execute") {
    return {
      summary: "Execute mode: using prompt as change description",
      description: prompt
    };
  }

  const t0 = Date.now();
  try {
    params.status("Plan: building detailed change description (modelSuperHeavy) …");

    const out = await params.openai.completeJson<ChangeDescription>({
      modelKind: "superHeavy",
      modelOverride: params.cfg.models.modelSuperHeavy,
      instructions: PROMPT_CHANGE_DESCRIPTION,
      input: [
        "AVAILABLE FILES (relative paths; scope is LIMITED to these):",
        (params.files ?? [])
          .map((f) => String(f?.rel ?? "").trim())
          .filter(Boolean)
          .map((r) => `- ${r}`)
          .join("\n") || "(none)",
        "",
        "USER PROMPT:",
        prompt
      ].join("\n"),
      maxRetries: 1
    });

    const cd: ChangeDescription = {
      summary: String((out as any)?.summary ?? "").trim() || "Change description",
      description: String((out as any)?.description ?? "").trim() || prompt,
      assumptions: Array.isArray((out as any)?.assumptions) ? (out as any).assumptions.map(String) : undefined,
      constraints: Array.isArray((out as any)?.constraints) ? (out as any).constraints.map(String) : undefined,
      nonGoals: Array.isArray((out as any)?.nonGoals) ? (out as any).nonGoals.map(String) : undefined,
      acceptanceCriteria: Array.isArray((out as any)?.acceptanceCriteria) ? (out as any).acceptanceCriteria.map(String) : undefined,
      risks: Array.isArray((out as any)?.risks) ? (out as any).risks.map(String) : undefined
    };

    params.trace?.addStep("phaseA_change_description", t0, Date.now(), {
      model: params.cfg.models.modelSuperHeavy,
      summary: cd.summary,
      preview: previewHeadTail(cd.description, 2500, 800)
    });

    return cd;
  } catch (e: any) {
    const msg = errMsg(e);
    params.diag.push(`Change description failed: ${msg}`);
    params.trace?.addEvent("phaseA_change_description_failed", { msg });

    return {
      summary: "Fallback change description",
      description: prompt
    };
  }
}
