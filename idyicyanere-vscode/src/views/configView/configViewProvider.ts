import * as vscode from "vscode";
import { ConfigService } from "../../storage/configService";
import { OpenAIService } from "../../openai/openaiService";
import { StoragePaths } from "../../storage/paths";
import { log } from "../../logging/logger";

import { WebviewIn, WebviewOut } from "./configContract";
import { handleConfigMessage, sendConfig } from "./configOps";
import { loadWebviewHtmlTemplate } from "../htmlUtils";

function isRecord(x: any): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

export class ConfigViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
    private readonly paths: StoragePaths,
    private readonly config: ConfigService,
    private readonly openai: OpenAIService
  ) {}

  private clearDisposables(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch (e: any) {
        log.caught("ConfigViewProvider.dispose", e);
      }
    }
    this.disposables = [];
  }

  private post(payload: WebviewOut): void {
    try {
      void this.view?.webview.postMessage(payload);
    } catch (e: any) {
      log.caught("ConfigViewProvider.post", e);
    }
  }

  private host() {
    return {
      post: (p: WebviewOut) => this.post(p),
      status: (text: string) => this.post({ type: "status", text: String(text ?? "") }),
      error: (text: string) => this.post({ type: "error", text: String(text ?? "") }),
    };
  }

  private deps() {
    return { paths: this.paths, config: this.config, openai: this.openai };
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

    // handlers first
    this.disposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        void this.guard("ConfigViewProvider.onDidReceiveMessage", async () => {
          if (!isRecord(raw) || typeof (raw as any).type !== "string") return;

          const msg = raw as WebviewIn;
          await handleConfigMessage(this.host(), this.deps(), msg);
        });
      })
    );

    // then HTML
    view.webview.html = await this.getHtml(view.webview);

    // best-effort initial state
    void this.guard("ConfigViewProvider.initialSendConfig", async () => {
      await sendConfig(this.host(), this.deps());
    });
  }

  refresh(): void {
    void this.guard("ConfigViewProvider.refresh", async () => {
      await sendConfig(this.host(), this.deps());
    });
  }
  
  private async getHtml(webview: vscode.Webview): Promise<string> {
    const { html } = await loadWebviewHtmlTemplate(this.context, webview, {
      templatePath: ["media", "views", "configView.html"],
    });
    return html;
  }
}
