import * as vscode from "vscode";
import OpenAI from "openai";
import { ConfigService } from "../storage/configService";
import { log } from "../logging/logger";

import { stripFirstMarkdownFence, parseTaggedObjectStrict, parseTaggedBySchema, TaggedSchema } from "./utils";


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
    const t = stripFirstMarkdownFence(raw).trim();
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
          instructions: [params.instructions, retryInstr].filter(Boolean).join("\n\n"),
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

    private buildTaggedSchemaInstructionsFromSchema<T>(schema: TaggedSchema<T>): string {
      const lines: string[] = [];
      lines.push("OUTPUT FORMAT (HARD): Return ONLY the tags shown below. No extra text, no markdown fences.");
      lines.push("");

      const render = (node: any, tagName: string | null, indent: string) => {
      const kind = node?.kind;

      if (kind === "object") {
        const keys: string[] = (node.order ?? Object.keys(node.fields ?? {})) as string[];

        if (tagName) lines.push(`${indent}<${tagName}>`);
        const innerIndent = tagName ? indent + "  " : indent;

        for (const k of keys) {
          const child = node.fields?.[k];
          if (!child) continue;
          const childTag = child.tag ?? k;
          render(child, String(childTag), innerIndent);
        }

        if (tagName) lines.push(`${indent}</${tagName}>`);
        return;
      }

      if (kind === "array") {
        if (!tagName) throw new Error("Array schema needs a tag name at render time.");
        lines.push(`${indent}<${tagName}>`);

        const innerIndent = indent + "  ";
        lines.push(`${innerIndent}<${node.itemTag}>`);
        render(node.item, null, innerIndent + "  ");
        lines.push(`${innerIndent}</${node.itemTag}>`);

        lines.push(`${indent}</${tagName}>`);
        return;
      }

      // primitive
      if (!tagName) {
        lines.push(`${indent}...`);
        return;
      }

      const placeholder =
        kind === "string" && node.cdata ? "<![CDATA[...]]>" : "...";
      lines.push(`${indent}<${tagName}>${placeholder}</${tagName}>`);
    };

    // Root rendering: usually root is an object with no wrapper tag
    render(schema as any, null, "");

    lines.push("");
    lines.push("Rules:");
    lines.push("- Output ONLY those tags.");
    lines.push("- For arrays, repeat the item blocks as needed.");
    lines.push("- You may wrap tag content in <![CDATA[...]]> if it contains '<' or '>' (recommended for diffs).");

    return lines.join("\n");
  }

  private buildTaggedSchemaInstructions(keys: readonly string[]): string {
    const lines: string[] = [];
    lines.push("OUTPUT FORMAT (HARD): Return ONLY these tags, in this exact order, nothing else:");

    for (const k of keys) {
      lines.push("");
      lines.push(`<${k}>`);
      lines.push("...text...");
      lines.push(`</${k}>`);
    }

    lines.push("");
    lines.push("Rules:");
    lines.push("- Output ONLY those tags. No markdown fences. No extra text before/after.");
    lines.push("- Do not repeat tags. Do not add any other tags.");
    lines.push("- Content can be multi-line plain text.");

    return lines.join("\n");
  }

  // Old flat mode (kept for compatibility)
  async language_request_with_TAGS_out<T extends Record<string, string>>(params: {
    input: string;
    instructions: string;
    schemaKeys: readonly (keyof T & string)[];
    modelKind?: "superHeavy" | "heavy" | "light";
    modelOverride?: string;
    maxRetries?: number;
    addFormatInstructions?: boolean;
    enforceOnlyTags?: boolean;
  }): Promise<T>;

  // New nested mode (schema-driven)
  async language_request_with_TAGS_out<T>(params: {
    input: string;
    instructions: string;
    schema: TaggedSchema<T>;
    modelKind?: "superHeavy" | "heavy" | "light";
    modelOverride?: string;
    maxRetries?: number;
    addFormatInstructions?: boolean;
    enforceOnlyTags?: boolean;
  }): Promise<T>;

  async language_request_with_TAGS_out<T>(params: any): Promise<T> {
    const t0 = Date.now();
    const client = await this.getClient();
    const model = this.getChatModel(params.modelKind ?? "default", params.modelOverride);
    const maxRetries = Math.max(1, Math.trunc(params.maxRetries ?? 2));

    const addFormatInstructions = params.addFormatInstructions !== false; // default true
    const enforceOnlyTags = params.enforceOnlyTags !== false;            // default true

    const hasSchema = !!params.schema;

    const formatInstr = !addFormatInstructions
      ? ""
      : hasSchema
        ? this.buildTaggedSchemaInstructionsFromSchema(params.schema as TaggedSchema<T>)
        : this.buildTaggedSchemaInstructions(params.schemaKeys as readonly string[]);

    let lastErr: any = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const retryInstr =
          attempt === 0
            ? ""
            : [
                "[Try again: Your output did not match the required tag format.]",
                `Previous error: ${lastErr?.message ?? String(lastErr)}`
              ].join("\n");

        const resp = await client.responses.create({
          model,
          instructions: [params.instructions, formatInstr, retryInstr].filter(Boolean).join("\n\n"),
          input: params.input
        });

        const raw = String(resp.output_text ?? "");

        const parsed = hasSchema
          ? parseTaggedBySchema<T>(raw, params.schema as TaggedSchema<T>, { enforceOnlyTags })
          : parseTaggedObjectStrict<any>(raw, params.schemaKeys, { enforceOnlyTags });

        log.debug("[language_request_with_TAGS_out] ok", {
          model,
          ms: Date.now() - t0,
          attempt,
          mode: hasSchema ? "schema" : "flat"
        });

        return parsed;
      } catch (err: any) {
        lastErr = err;
        log.warn("[language_request_with_TAGS_out] failed to parse tagged output", {
          model,
          attempt,
          msg: err?.message ?? String(err)
        });
      }
    }

    log.caught("[language_request_with_TAGS_out] OpenAIService.language_request_with_TAGS_out", lastErr);
    throw lastErr ?? new Error("language_request_with_TAGS_out failed");
  }

  async answerWithContext(
    question: string,
    context: string,
    params?: {
      modelKind?: "superHeavy" | "heavy" | "light";
      modelOverride?: string;
    }
  ): Promise<string> {
    const t0 = Date.now();

    try {
      const client = await this.getClient();
      const model = this.getChatModel(params?.modelKind ?? "heavy", params?.modelOverride);

      const instructions = [
        "Role: Coding assistant inside a VS Code extension.",
        "You will receive a QUESTION and a CONTEXT (retrieved from the user's indexed workspace).",
        "",
        "Rules:",
        "- Use the CONTEXT as your primary source of truth.",
        "- If the CONTEXT is insufficient, say so explicitly and suggest what file(s) to index or what info is missing.",
        "- Be concrete: point to relevant functions/types/paths mentioned in CONTEXT when possible.",
        "- Output markdown is allowed."
      ].join("\n");

      const input = [
        "QUESTION:",
        String(question ?? "").trim(),
        "",
        "CONTEXT:",
        String(context ?? "").trim()
      ].join("\n");

      log.debug("OpenAI answerWithContext request", {
        model,
        questionChars: (question ?? "").length,
        contextChars: (context ?? "").length
      });

      const resp = await client.responses.create({
        model,
        instructions,
        input
      });

      const out = String(resp.output_text ?? "").trim();

      log.debug("OpenAI answerWithContext response", {
        model,
        ms: Date.now() - t0,
        answerChars: out.length
      });

      return out;
    } catch (err) {
      log.caught("OpenAIService.answerWithContext", err);
      throw err;
    }
  }
}
