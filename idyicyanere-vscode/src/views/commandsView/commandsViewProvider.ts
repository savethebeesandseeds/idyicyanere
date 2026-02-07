import * as vscode from "vscode";
import { log } from "../../logging/logger";

import { WebviewIn, WebviewOut } from "./commandsContract";
import { handleCommandsMessage } from "./commandsOps";
import { loadWebviewHtmlTemplate } from "../htmlUtils";

function isRecord(x: any): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

export class CommandsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "idyicyanereCommands";

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private extensionUri: vscode.Uri
  ) {}

  private clearDisposables(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch (e: any) {
        log.caught("CommandsViewProvider.dispose", e);
      }
    }
    this.disposables = [];
  }

  private post(msg: WebviewOut) {
    try {
      void this.view?.webview.postMessage(msg);
    } catch (e: any) {
      log.caught("CommandsViewProvider.post", e);
    }
  }

  private host() {
    return {
      post: (p: WebviewOut) => this.post(p),
      error: (text: string) => this.post({ type: "error", text: String(text ?? "") }),
      log: (text: string) => this.post({ type: "log", text: String(text ?? "") }),
    };
  }

  private async guard(where: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e: any) {
      log.caught(where, e);
      this.post({ type: "error", text: String(e?.message ?? e) });
    }
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.clearDisposables();
    this.view = webviewView;

    webviewView.onDidDispose(
      () => {
        this.view = undefined;
        this.clearDisposables();
      },
      undefined,
      this.disposables
    );

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    // handlers first
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((raw: unknown) => {
        void this.guard("CommandsViewProvider.onDidReceiveMessage", async () => {
          if (!isRecord(raw) || typeof (raw as any).type !== "string") {
            return;
          }
          await handleCommandsMessage(this.host(), raw as WebviewIn);
        });
      })
    );

    // then HTML
    webviewView.webview.html = await this.getHtml(webviewView.webview);
  }
  
  private async getHtml(webview: vscode.Webview): Promise<string> {
    const { html } = await loadWebviewHtmlTemplate(this.context, webview, {
      templatePath: ["media", "views", "commandsView.html"],
    });
    return html;
  }
}
