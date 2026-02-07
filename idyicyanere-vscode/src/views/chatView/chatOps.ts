import { ConfigService } from "../../storage/configService";
import { OpenAIService } from "../../openai/openaiService";
import { IdyDbStore } from "../../storage/idyDbStore";
import { IndexService } from "../../indexing/indexService";
import { log } from "../../logging/logger";

import { WebviewIn, WebviewOut } from "./chatContract";

export type ChatDeps = {
  store: IdyDbStore;
  config: ConfigService;
  openai: OpenAIService;
  indexer: IndexService;
};

export type ChatHost = {
  post(payload: WebviewOut): void;
  status(text: string): void;
  error(text: string): void;
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, rej) => {
    t = setTimeout(() => rej(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (t) clearTimeout(t);
  }) as Promise<T>;
}

function msSince(t0: number): number {
  return Date.now() - t0;
}

async function ensureFreshIncludedIndex(host: ChatHost, deps: ChatDeps, limit: number): Promise<void> {
  host.status("Checking for stale indexed files…");

  const refresh = await deps.indexer.reindexStaleIncluded({
    limit,
    onProgress: (s) => host.status(s),
  });

  if (refresh.found > 0) log.info("Chat RAG: refreshed stale files", refresh);
}

export async function handleAsk(host: ChatHost, deps: ChatDeps, raw: string): Promise<void> {
  const question = (raw ?? "").trim();
  if (!question) return;

  const t0 = Date.now();
  log.info("Chat ask", { questionChars: question.length });

  try {
    host.status("Loading config…");
    log.info("Chat ask: config.ensure start");
    await withTimeout(deps.config.ensure(), 15_000, "config.ensure()");
    log.info("Chat ask: config.ensure ok", { ms: msSince(t0) });

    host.status("Checking for stale indexed files…");
    log.info("Chat ask: ensureFreshIncludedIndex start");
    await withTimeout(ensureFreshIncludedIndex(host, deps, 50), 60_000, "ensureFreshIncludedIndex()");
    log.info("Chat ask: ensureFreshIncludedIndex ok", { ms: msSince(t0) });

    host.status("Embedding question…");
    log.info("Chat ask: embedTexts start");
    const [qVec] = await withTimeout(deps.openai.embedTexts([question]), 60_000, "openai.embedTexts(question)");
    log.info("Chat ask: embedTexts ok", { ms: msSince(t0) });

    const { k, metric, maxChars } = deps.config.data.rag;

    host.status(`Searching vector DB (top ${k})…`);
    log.info("Chat ask: queryContext start", { k, metric, maxChars });
    const context = await withTimeout(deps.store.queryContext(qVec, k, metric, maxChars), 30_000, "store.queryContext()");
    log.info("Chat ask: queryContext ok", { ms: msSince(t0), contextChars: context?.length ?? 0 });

    if (!context || context.trim().length === 0) {
      log.info("Chat ask: no indexed context available");
      host.post({
        type: "answer",
        question,
        answer:
          "I don’t have any indexed context yet.\n\n" +
          "Go to the Files view and check a few files to index them, then ask again."
      });
      host.status("");
      return;
    }

    host.status("Asking model with RAG context…");
    log.info("Chat ask: answerWithContext start");
    const answer = await withTimeout(deps.openai.answerWithContext(question, context), 90_000, "openai.answerWithContext()");
    log.info("Chat ask complete", { ms: msSince(t0), answerChars: (answer ?? "").length });

    host.status("");
    host.post({ type: "answer", question, answer: answer || "(no output)" });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    log.error("Chat ask failed", { error: msg, stack: e?.stack, ms: msSince(t0) });
    host.status("");
    host.post({ type: "answer", question, answer: `Chat failed: ${msg}` });
  }
}

export async function handleChatMessage(host: ChatHost, deps: ChatDeps, msg: WebviewIn): Promise<void> {
  if (msg.type === "ask") {
    await handleAsk(host, deps, msg.text);
    return;
  }

  if (msg.type === "clear") {
    host.post({ type: "clear" });
    return;
  }

  if (msg.type === "clientError") {
    log.error("Chat webview JS error", { text: msg.text, stack: msg.stack });
    return;
  }

  host.error(`Unknown message type: ${(msg as any)?.type ?? "(missing type)"}`);
}