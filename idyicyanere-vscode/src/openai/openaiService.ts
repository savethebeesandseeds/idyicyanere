import * as vscode from "vscode";
import OpenAI from "openai";
import { ConfigService } from "../storage/configService";
import { log } from "../logging/logger";

export class OpenAIService {
  private client: OpenAI | null = null;
  private static readonly SECRET_KEY = "idyicyanere.openaiApiKey";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly config: ConfigService
  ) {}

  async setApiKey(key: string) {
    await this.context.secrets.store(OpenAIService.SECRET_KEY, key);
    this.client = null;
    log.info("OpenAI API key stored (secret)", { resetClient: true });
  }
  
  async hasApiKey(): Promise<boolean> {
    const key = await this.context.secrets.get(OpenAIService.SECRET_KEY);
    return !!key;
  }

  private async getClient(): Promise<OpenAI> {
    if (this.client) return this.client;

    const key = await this.context.secrets.get(OpenAIService.SECRET_KEY);
    if (!key) {
      log.warn("OpenAI API key not set");
      throw new Error("OpenAI API key not set. Run: idyicyanere: Set OpenAI API Key");
    }

    this.client = new OpenAI({ apiKey: key });
    log.debug("OpenAI client created");
    return this.client;
  }

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    const t0 = Date.now();

    try {
      const client = await this.getClient();
      const model = this.config.data.openai.embeddingModel;

      log.debug("OpenAI embeddings request", {
        model,
        count: texts.length,
        totalChars: texts.reduce((a, s) => a + (s?.length ?? 0), 0)
      });

      const resp = await client.embeddings.create({
        model,
        input: texts
      });

      log.debug("OpenAI embeddings response", {
        model,
        count: resp.data.length,
        ms: Date.now() - t0
      });

      return resp.data.map((d) => new Float32Array(d.embedding));
    } catch (err) {
      log.caught("OpenAIService.embedTexts", err);
      throw err;
    }
  }

  private stripFirstMarkdownFence(s: string): string {
    const t = String(s ?? "");
    const m = t.match(/```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```/);
    return m ? m[1] : t;
  }

  private getChatModel(kind: "superHeavy" | "heavy" | "light" | "default" = "default", override?: string): string {
    if (override) return override;
    const anyCfg = this.config.data as any;
    const openaiCfg = anyCfg?.openai ?? {};

    if (kind === "light") return String(openaiCfg.modelLight);
    if (kind === "heavy") return String(openaiCfg.modelHeavy);
    if (kind === "superHeavy") return String(openaiCfg.modelSuperHeavy);
    return String(openaiCfg.modelHeavy); // default
  }

  private extractFirstJsonBlock(raw: string): string {
    const t = this.stripFirstMarkdownFence(raw).trim();
    const start = t.search(/[{\[]/);
    if (start < 0) return t;
    const open = t[start];
    const close = open === "{" ? "}" : "]";

    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") { inStr = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return t.slice(start, i + 1);
      }
    }
    return t.slice(start);
  }

  async completeJson<T>(
    params: {
      input: string;
      instructions: string;
      modelKind?: "superHeavy" | "heavy" | "light";
      modelOverride?: string;
      maxRetries?: number;
    }
  ): Promise<T> {
    const t0 = Date.now();
    const client = await this.getClient();

    const sys = (this.config.data.chatContext?.system ?? []).filter(Boolean);
    const agent = (this.config.data.chatContext?.agent ?? []).filter(Boolean);
    const agentBlock = agent.length ? `AGENT GUIDANCE:\n${agent.join("\n")}\n\n` : "";

    const model = this.getChatModel(params.modelKind ?? "default", params.modelOverride);
    // Default to 2 => up to 3 total attempts (initial + 2 repairs)
    const maxRetries = Math.max(0, Math.trunc(params.maxRetries ?? 2));

    let lastErr: any = null;
    let lastRaw = "";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const retryInstr =
          attempt === 0
            ? ""
            : [
                "IMPORTANT:",
                "Your previous output was invalid JSON and could not be parsed.",
                "Return ONLY corrected valid JSON that matches the required schema.",
                "No markdown, no commentary, no leading/trailing text."
              ].join("\n");

        const prev = attempt > 0 && lastRaw
          ? [
              "",
              "PREVIOUS_INVALID_OUTPUT (for repair):",
              "<<<",
              lastRaw.slice(0, 6000),
              ">>>"
            ].join("\n")
          : "";

        const resp = await client.responses.create({
          model,
          instructions: [...sys, params.instructions, retryInstr].filter(Boolean).join("\n\n"),
          input: `${agentBlock}${params.input}${prev}`
        });

        const raw = resp.output_text ?? "";
        lastRaw = raw;
        const jsonText = this.extractFirstJsonBlock(raw);
        const parsed = JSON.parse(jsonText) as T;

        log.debug("OpenAI completeJson ok", { model, ms: Date.now() - t0, chars: jsonText.length, attempt });
        return parsed;
      } catch (err: any) {
        lastErr = err;
        log.warn("OpenAI completeJson parse/retry", { model, attempt, msg: err?.message ?? String(err) });
      }
    }
    log.caught("OpenAIService.completeJson", lastErr);
    throw lastErr ?? new Error("completeJson failed");
  }

  /**
   * Single-file editor.
   * Returns full updated file contents (plain text).
   *
   * NOTE: Intentionally simple; later you can switch to structured diffs / tool calls.
   */
  async editFile(prompt: string, rel: string, currentText: string, modelOverride?: string): Promise<string> {
    const t0 = Date.now();
    const client = await this.getClient();
    const model = this.getChatModel("default", modelOverride);

    const sys = (this.config.data.chatContext?.system ?? []).filter(Boolean);
    const agent = (this.config.data.chatContext?.agent ?? []).filter(Boolean);

    const instructions = [
      ...sys,
      "You are an automated code editor running inside a VS Code extension.",
      "You will be given a USER PROMPT and a single TARGET FILE with its CURRENT CONTENT.",
      "Return ONLY the full updated file contents as plain text.",
      "Do NOT include Markdown, code fences (```), JSON, or commentary.",
      "If no changes are needed, return the original content exactly."
    ].join("\n\n");

    const agentBlock = agent.length ? `AGENT GUIDANCE:\n${agent.join("\n")}\n\n` : "";
    const input =
      `${agentBlock}USER PROMPT:\n${prompt}\n\n` +
      `TARGET FILE: ${rel}\n\n` +
      `CURRENT CONTENT:\n<<<\n${currentText}\n>>>`;

    const resp = await client.responses.create({ model, instructions, input });
    const raw = resp.output_text ?? "";
    const cleaned = this.stripFirstMarkdownFence(raw);

    log.debug("OpenAI editFile response", {
      model,
      rel,
      outputChars: cleaned.length,
      ms: Date.now() - t0
    });

    return cleaned;
  }

  /**
   * Segment editor: returns ONLY the updated segment text (not a full file).
   * This enables per-file sub-changes (hunks/segments).
   */
  async editFragment(
    prompt: string,
    rel: string,
    fragmentLabel: string,
    fragmentText: string,
    beforeContext: string,
    afterContext: string, 
    modelOverride?: string
  ): Promise<string> {
    const t0 = Date.now();
    const client = await this.getClient();
    const model = this.getChatModel("default", modelOverride);

    const sys = (this.config.data.chatContext?.system ?? []).filter(Boolean);
    const agent = (this.config.data.chatContext?.agent ?? []).filter(Boolean);

    const instructions = [
      ...sys,
      "You are an automated code editor running inside a VS Code extension.",
      "You will be given a USER PROMPT and a FRAGMENT of a file.",
      "Return ONLY the updated FRAGMENT text as plain text.",
      "Do NOT include markdown, code fences, JSON, or commentary.",
      "Do NOT repeat the before/after context. Only output the fragment.",
      "If no changes are needed, return the fragment exactly as-is."
    ].join("\n\n");

    const agentBlock = agent.length ? `AGENT GUIDANCE:\n${agent.join("\n")}\n\n` : "";

    const input =
      `${agentBlock}USER PROMPT:\n${prompt}\n\n` +
      `TARGET FILE: ${rel}\n` +
      `FRAGMENT: ${fragmentLabel}\n\n` +
      `BEFORE CONTEXT (read-only):\n<<<\n${beforeContext}\n>>>\n\n` +
      `FRAGMENT TEXT (edit this):\n<<<\n${fragmentText}\n>>>\n\n` +
      `AFTER CONTEXT (read-only):\n<<<\n${afterContext}\n>>>`;

    const resp = await client.responses.create({ model, instructions, input });
    const raw = resp.output_text ?? "";
    const cleaned = this.stripFirstMarkdownFence(raw);

    log.debug("OpenAI editFragment response", {
      model,
      rel,
      fragmentLabel,
      outputChars: cleaned.length,
      ms: Date.now() - t0
    });

    return cleaned;
  }

  async answerWithContext(question: string, context: string, modelOverride?: string): Promise<string> {
    const t0 = Date.now();

    try {
      const client = await this.getClient();
      const model = this.getChatModel("default", modelOverride);

      log.debug("OpenAI responses request", {
        model,
        questionChars: question?.length ?? 0,
        contextChars: context?.length ?? 0
      });

      const sys = (this.config.data.chatContext?.system ?? []).filter(Boolean);
      const agent = (this.config.data.chatContext?.agent ?? []).filter(Boolean);

      const instructions = [ ...sys ].join("\n\n");

      const agentBlock = agent.length ? `AGENT GUIDANCE:\n${agent.join("\n")}\n\n` : "";

      const resp = await client.responses.create({
        model,
        instructions,
        input: `${agentBlock}CONTEXT:\n${context}\n\nQUESTION:\n${question}`
      });

      log.debug("OpenAI responses response", {
        model,
        outputChars: (resp.output_text ?? "").length,
        ms: Date.now() - t0
      });

      return resp.output_text ?? "";
    } catch (err) {
      log.caught("OpenAIService.answerWithContext", err);
      throw err;
    }
  }
}
