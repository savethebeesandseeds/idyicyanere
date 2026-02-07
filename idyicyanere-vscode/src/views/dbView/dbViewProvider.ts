import * as vscode from "vscode";
import { StoragePaths } from "../../storage/paths";
import { ManifestService } from "../../storage/manifestService";
import { ConfigService } from "../../storage/configService";
import { OpenAIService } from "../../openai/openaiService";
import { IdyDbStore } from "../../storage/idyDbStore";
import { IndexService } from "../../indexing/indexService";
import { log } from "../../logging/logger";

import { WebviewIn, WebviewOut } from "./dbContract";
import { handleDbMessage, DbDeps, DbHost, sendStats } from "./dbOps";
import { loadWebviewHtmlTemplate } from "../htmlUtils";

function isRecord(x: any): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

export class DbViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
    private readonly paths: StoragePaths,
    private readonly manifest: ManifestService,
    private readonly indexer: IndexService,
    private readonly store: IdyDbStore,
    private readonly config: ConfigService,
    private readonly openai: OpenAIService,
    private readonly onIndexMutated?: (uri?: vscode.Uri) => void
  ) {}

  private clearDisposables(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch (e: any) {
        log.caught("DbViewProvider.dispose", e);
      }
    }
    this.disposables = [];
  }

  private post(payload: WebviewOut): void {
    try {
      void this.view?.webview.postMessage(payload);
    } catch (e: any) {
      log.caught("DbViewProvider.post", e);
    }
  }

  private makeHost(): DbHost {
    return {
      post: (p) => this.post(p),
      status: (text) => this.post({ type: "status", text: String(text ?? "") }),
      error: (text) => this.post({ type: "error", text: String(text ?? "") }),

      withProgress: async (title, uri, fn) => {
        const rel = vscode.workspace.asRelativePath(uri, false);
        const label = `${title} ${rel}`;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: label, cancellable: false },
          () => {
            return Promise.resolve()
              .then(() => fn())
              .catch((err) => {
                // loud + consistent
                log.caught(`DbHost.withProgress(${label})`, err);
                this.post({ type: "error", text: `${title} failed for ${rel} (see logs).` });
                throw err; // keep failure semantics
              });
          }
        );
      },
    };
  }

  private deps(): DbDeps {
    return {
      paths: this.paths,
      manifest: this.manifest,
      indexer: this.indexer,
      store: this.store,
      config: this.config,
      openai: this.openai,
      onIndexMutated: this.onIndexMutated,
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

  // MAKE THIS ASYNC so we can await HTML
  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    log.debug("DbViewProvider.resolveWebviewView()");
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

    // Register handlers BEFORE setting HTML.
    this.disposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        void this.guard("DbViewProvider.onDidReceiveMessage", async () => {
          if (!isRecord(raw) || typeof (raw as any).type !== "string") {
            log.warn("DbViewProvider: ignored non-message payload", { rawType: typeof raw });
            return;
          }

          const msg = raw as WebviewIn;
          log.debug("DB webview message", { type: msg.type });

          await handleDbMessage(this.makeHost(), this.deps(), msg);
        });
      })
    );

    // SET HTML (async)
    await this.guard("DbViewProvider.setHtml", async () => {
      view.webview.html = await this.getHtml(view.webview);
    });

    // Initial stats (best-effort)
    void this.guard("DbViewProvider.initialStats", async () => {
      await sendStats(this.makeHost(), this.deps());
    });
  }

  refresh(): void {
    void this.guard("DbViewProvider.refresh", async () => {
      await sendStats(this.makeHost(), this.deps());
    });
  }

  private async getHtml(webview: vscode.Webview): Promise<string> {
    const { html } = await loadWebviewHtmlTemplate(this.context, webview, {
      templatePath: ["media", "views", "dbView.html"],
      csp: {},
      substitutions: {},
    });

    return html;
  }
}
