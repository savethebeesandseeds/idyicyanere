import * as vscode from "vscode";
import { ConfigService } from "../../storage/configService";
import { IndexService } from "../../indexing/indexService";
import { log } from "../../logging/logger";

import { WebviewIn, WebviewOut } from "./filesContract";
import { handleFilesMessage, FilesDeps, FilesHost, filesApi } from "./filesOps";
import { loadWebviewHtmlTemplate } from "../htmlUtils";

function isRecord(x: any): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

export class FilesViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
    private readonly indexer: IndexService,
    private readonly config: ConfigService
  ) {}

  private clearDisposables(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch (e: any) {
        log.caught("FilesViewProvider.dispose", e);
      }
    }
    this.disposables = [];
  }

  private post(payload: WebviewOut): void {
    try {
      void this.view?.webview.postMessage(payload);
    } catch (e: any) {
      log.caught("FilesViewProvider.post", e);
    }
  }

  private host(): FilesHost {
    return {
      post: (p) => this.post(p),
      status: (text) => this.post({ type: "status", text: String(text ?? "") }),
      error: (text) => this.post({ type: "error", text: String(text ?? "") }),

      withProgress: async (title, fn) => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title, cancellable: false },
          () => {
            return Promise.resolve()
              .then(() => fn())
              .catch((err) => {
                log.caught(`FilesHost.withProgress(${title})`, err);
                this.post({ type: "error", text: `${title} failed (see logs).` });
                throw err;
              });
          }
        );
      },
    };
  }

  private deps(): FilesDeps {
    return { indexer: this.indexer, config: this.config };
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

    // Handlers first
    this.disposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        void this.guard("FilesViewProvider.onDidReceiveMessage", async () => {
          if (!isRecord(raw) || typeof (raw as any).type !== "string") {
            log.warn("FilesViewProvider: ignored non-message payload", { rawType: typeof raw });
            return;
          }

          const msg = raw as WebviewIn;
          await handleFilesMessage(this.host(), this.deps(), msg);
        });
      })
    );

    // Then HTML
    view.webview.html = await this.getHtml(view.webview);

    // Best-effort initial refresh (optional)
    void this.guard("FilesViewProvider.initialRoots", async () => {
      await filesApi.sendRoots(this.host(), this.deps());
    });
  }

  refresh(): void {
    void this.guard("FilesViewProvider.refresh", async () => {
      await filesApi.sendRoots(this.host(), this.deps());
    });
  }

  private async getHtml(webview: vscode.Webview): Promise<string> {
    const { html } = await loadWebviewHtmlTemplate(this.context, webview, {
      templatePath: ["media", "views", "filesView.html"],
    });
    return html;
  }
}