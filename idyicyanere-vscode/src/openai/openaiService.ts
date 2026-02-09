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

  async language_request_with_JSON_out<T>(
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
    const model = this.getChatModel(params.modelKind ?? "default", params.modelOverride);
    const maxRetries = Math.max(1, Math.trunc(params.maxRetries ?? 2));

    let lastErr: any = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const retryInstr = attempt === 0 ? "" : `\n[Try again: Respond with a valid JSON that matches the specified schema]\nCAREFULL WITH: ${lastErr}\n`;

        const resp = await client.responses.create({
          model,
          instructions: [...params.instructions, retryInstr].filter(Boolean).join("\n\n"),
          input: params.input
        });

        const raw = resp.output_text;
        const jsonText = this.extractFirstJsonBlock(raw);
        const parsed = JSON.parse(jsonText) as T;

        log.debug("[language_request_with_JSON_out] OpenAI completeJson ok", { model, ms: Date.now() - t0, chars: jsonText.length, attempt});
        return parsed;
      } catch (err: any) {
        lastErr = err;
        log.warn("[language_request_with_JSON_out] OpenAI failed to parse JSON: ", { model, attempt, msg: err?.message ?? String(err) });
      }
    }
    log.caught("[language_request_with_JSON_out] OpenAIService.language_request_with_JSON_out", lastErr);
    throw lastErr ?? new Error("completeJson failed");
  }

  /* other language_request where not needed */
}
