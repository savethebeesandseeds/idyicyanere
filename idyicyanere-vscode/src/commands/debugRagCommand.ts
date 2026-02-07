import * as vscode from "vscode";
import { log } from "../logging/logger";
import { OpenAIService } from "../openai/openaiService";
import { ConfigService } from "../storage/configService";

type IndexerLike = { reindexStaleIncluded: (args: { limit: number }) => Promise<{ found: number }> };
type StoreLike = { queryContext: (qVec: Float32Array, k: number, metric: any, maxChars: number) => Promise<string> };

export async function runDebugRagCommand(args: {
  indexer: IndexerLike;
  store: StoreLike;
  openai: OpenAIService;
  config: ConfigService;
}): Promise<void> {
  log.info("Command: idyicyanere.debugRag");

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Refreshing stale indexed files…", cancellable: false },
    () => {
      return (async () => {
        try {
          const r = await args.indexer.reindexStaleIncluded({ limit: 50 });
          if (r.found > 0) log.info("debugRag: refreshed stale files", r);
        } catch (err) {
          log.caught("Command: refreshStaleIndexedFiles", err);
          vscode.window.showErrorMessage("idyicyanere: refresh stale files failed (see logs).");
        }
      })();
    }
  );

  const question = await vscode.window.showInputBox({
    prompt: "RAG debug query",
    ignoreFocusOut: true
  });
  if (!question) return;

  await args.config.ensure();

  const [qVec] = await args.openai.embedTexts([question]);
  const { k, metric, maxChars } = args.config.data.rag;

  const contextText = await args.store.queryContext(qVec, k, metric, maxChars);

  log.show(true);
  log.info("RAG debug result", { questionChars: question.length, contextChars: contextText.length });
  log.debug("RAG context preview", { preview: contextText.slice(0, 1500) });

  vscode.window.showInformationMessage(`RAG context chars: ${contextText.length}`);
}
