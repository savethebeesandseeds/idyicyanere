import * as vscode from "vscode";
import { ConfigService } from "../../storage/configService";
import { OpenAIService } from "../../openai/openaiService";
import { IdyDbStore } from "../../storage/idyDbStore";
import { log } from "../../logging/logger";
import { IndexService } from "../../indexing/indexService";

import { WebviewIn, WebviewOut } from "./chatContract";
import { handleChatMessage, ChatDeps, ChatHost } from "./chatOps";
import { loadWebviewHtmlTemplate } from "../htmlUtils";

function isRecord(x: any): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
    private readonly store: IdyDbStore,
    private readonly config: ConfigService,
    private readonly openai: OpenAIService,
    private readonly indexer: IndexService
  ) {}

  private clearDisposables(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch (e: any) {
        log.caught("ChatViewProvider.dispose", e);
      }
    }
    this.disposables = [];
  }

  private post(payload: WebviewOut): void {
    try {
      void this.view?.webview.postMessage(payload);
    } catch (e: any) {
      log.caught("ChatViewProvider.post", e);
    }
  }

  private host(): ChatHost {
    return {
      post: (p) => this.post(p),
      status: (text) => this.post({ type: "status", text: String(text ?? "") }),
      error: (text) => this.post({ type: "error", text: String(text ?? "") }),
    };
  }

  private deps(): ChatDeps {
    return {
      store: this.store,
      config: this.config,
      openai: this.openai,
      indexer: this.indexer,
    };
  }

  private async guard(where: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e: any) {
      log.caught(where, e);
      this.post({ type: "error", text: e?.message ?? String(e) });
    }
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    log.debug("ChatViewProvider.resolveWebviewView()");
    this.clearDisposables();

    this.view = view;

    view.onDidDispose(
      () => {
        this.view = undefined;
        this.clearDisposables();
      },
      undefined,
      this.disposables
    );

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    // Handlers first, then HTML (avoids missing early posts).
    this.disposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        void this.guard("ChatViewProvider.onDidReceiveMessage", async () => {
          if (!isRecord(raw) || typeof (raw as any).type !== "string") {
            log.warn("ChatViewProvider: ignored non-message payload", { rawType: typeof raw });
            return;
          }

          const msg = raw as WebviewIn;
          log.debug("Chat webview message", { type: msg.type });

          if (msg.type === "clientError") {
            log.warn("ChatView: clientError from webview", { text: msg.text, stack: msg.stack });
            return;
          }

          // Optional: ignore unknowns quietly to avoid spamming user UI
          if (msg.type !== "ask" && msg.type !== "clear") {
            log.warn("ChatViewProvider: ignored unknown message type", { type: (msg as any).type });
            return;
          }

          await handleChatMessage(this.host(), this.deps(), msg);
        });
      })
    );

    view.webview.html = await this.getHtml(view.webview);
  }


  refresh(): void {
    if (!this.view) return;
  }

  private async getHtml(webview: vscode.Webview): Promise<string> {
    const { html } = await loadWebviewHtmlTemplate(this.context, webview, {
      templatePath: ["media", "views", "chatView.html"],
    });
    return html;
  }
}
