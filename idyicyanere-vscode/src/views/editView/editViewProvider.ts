import * as vscode from "vscode";
import { ConfigService } from "../../storage/configService";
import { ManifestService } from "../../storage/manifestService";
import { OpenAIService } from "../../openai/openaiService";
import { log } from "../../logging/logger";
import { ProposedContentProvider } from "../../editing/proposedContentProvider";
import { EditState, RunRecord, EMPTY_STATE } from "./editState";
import { IdyDbStore } from "../../storage/idyDbStore";
import { IndexService } from "../../indexing/indexService";
import { WebviewIn, WebviewOut } from "./editTypes";
import { EditHost } from "./editHost";
import { buildEditViewPayload } from "./editPresenter";
import { handlePlanRun } from "./editPlanRun";
import {
  handleApplyAll,
  handleApplySelected,
  handleDiscardChange,
  handleDiscardRun,
  handleClearView,
  handleOpenDiff,
  handleOpenTrace,
  handleRollback,
  handleUpdateDraft,
  ApplyDeps,
} from "./editApplyOps";
import type { PlanMode } from "../../editing/pipeline/tools/types";
import { loadWebviewHtmlTemplate } from "../htmlUtils";
import { PlannerTraceCollector } from "../../editing/pipeline/tools/trace";

function isRecord(x: any): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

type CancelSource = {
  cancel: () => void;
  isCancelled: () => boolean;
  wait: Promise<void>;
};

function makeCancelSource(): CancelSource {
  let cancelled = false;
  let resolve!: () => void;

  const wait = new Promise<void>((r) => { resolve = r; });

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      resolve();
    },
    isCancelled: () => cancelled,
    wait,
  };
}

export class EditViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  private busy = false;
  private state: EditState = { ...EMPTY_STATE };

  private disposables: vscode.Disposable[] = [];
  private lastStatusText = "";

  private planCancel: CancelSource | null = null;
  
  private planTrace: PlannerTraceCollector | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
    private readonly config: ConfigService,
    private readonly manifest: ManifestService,
    private readonly openai: OpenAIService,
    private readonly proposedProvider: ProposedContentProvider,
    private readonly ragStore: IdyDbStore,
    private readonly indexer: IndexService
  ) {}


  private makeHost(): EditHost {
    return {
      getState: () => this.state,
      setState: (next) => (this.state = next),

      ui: (p, where) => this.ui(p, where),
      withBusy: (where, status, fn) => this.withBusy(where, status, fn),

      scheduleSave: () => this.scheduleSave(),
      sendState: () => this.sendState(),

      getActiveRun: () => this.getActiveRun(),
      ensure_index: () => this.ensure_index(),

      getTrace: () => this.planTrace
    };
  }

  private applyDeps(): ApplyDeps {
    return { proposedProvider: this.proposedProvider };
  }

  /**
   * Loud UI post: logs + never throws.
   */
  private ui(payload: WebviewOut, where = "EditViewProvider.ui"): void {
    const type = (payload as any)?.type;

    try {
      if (type === "error") {
        log.error("webview<- error", { where, text: (payload as any)?.text ?? "" });
      } else if (type === "status") {
        const text = String((payload as any)?.text ?? "");
        if (text === this.lastStatusText) return;
        this.lastStatusText = text;
        log.debug("webview<- status", { where, text });
      } else if (type === "state") {
        const p = (payload as any)?.payload;
        const a = p?.active;
        log.debug("webview<- state", {
          where,
          active: a ? { id: a.id, files: (a.files ?? []).length, issueCount: a.issueCount } : null,
          historyCount: Array.isArray(p?.history) ? p.history.length : 0,
        });
      } else {
        log.debug("webview<- msg", { where, type });
      }
    } catch (e: any) {
      log.caught(where + ":log", e);
    }

    try {
      void this.view?.webview.postMessage(payload);
    } catch (e: any) {
      log.caught(where + ":postMessage", e);
    }
  }

  private async guard<T>(where: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e: any) {
      log.caught(where, e);
      this.ui({ type: "error", text: `Error: ${e?.message ?? String(e)}` }, "guard/caught");
      return undefined;
    }
  }

  private clearDisposables(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch (e: any) {
        log.caught("EditViewProvider.dispose", e);
      }
    }
    this.disposables = [];
  }

  private async ensure_index(): Promise<void> {
    await this.ensureConfigAndManifest();

    this.ui({ type: "status", text: "Checking for stale indexed files…" }, "ensure_index");
    const refresh = await this.indexer.reindexStaleIncluded({
      limit: 50,
      onProgress: (s) => this.ui({ type: "status", text: s }, "ensure_index/progress"),
    });

    if (refresh.found > 0) log.info("Edit: refreshed stale files", refresh);
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    log.info("EditViewProvider.resolveWebviewView()", { viewType: (this as any).constructor?.name });
    vscode.window.setStatusBarMessage("idy: Edit view resolved", 4000);

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

    this.disposables.push(
      view.webview.onDidReceiveMessage((raw: any) => {
        void this.guard("EditViewProvider.onDidReceiveMessage", async () => {
          if (!isRecord(raw) || typeof raw.type !== "string") {
            log.warn("EditViewProvider: ignored non-message payload", { rawType: typeof raw });
            return;
          }

          const msg = raw as WebviewIn;
          const noisy = msg.type === "updateDraft";
          (noisy ? log.debug : log.info)("EditViewProvider message:", { type: msg.type });

          if (msg.type === "clientLog") {
            log.info("Edit webview log", { text: msg.text, data: msg.data });
            return;
          }

          if (msg.type === "ready" || msg.type === "refresh") {
            this.ui({ type: "status", text: "Connected to extension host." }, "webview/ready");
            await this.sendState();
            return;
          }

          const host = this.makeHost();
          const deps = this.applyDeps();

          if (msg.type === "run") {
            this.ui({ type: "status", text: "Run received. Starting…" }, "webview/run");

            const rawMode = (msg as any).mode;
            const mode: PlanMode =
              rawMode === "execute" || rawMode === "auto" || rawMode === "plan" ? rawMode : "auto";

            //  cancel any prior run, then create a fresh cancel source for this run
            this.planCancel?.cancel();
            const cancel = makeCancelSource();
            this.planCancel = cancel;

            this.planTrace = new PlannerTraceCollector({
              cfg: this.config.data.editPlanner
            });

            try {
              await handlePlanRun(
                host,
                { config: this.config, manifest: this.manifest, openai: this.openai, ragStore: this.ragStore },
                msg.prompt,
                mode,
                cancel
              );
            } finally {
              // only clear if still the same token
              if (this.planCancel === cancel) this.planCancel = null;
            }

            return;
          }

          if (msg.type === "discardRun") {
            this.planCancel?.cancel();

            await handleDiscardRun(host);
            return;
          }

          if (msg.type === "clearView") {
            await handleClearView(host);
            return;
          }

          if (msg.type === "clearHistory") {
            await this.resetHistory();
            return;
          }

          if (msg.type === "openFile") {
            const uri = vscode.Uri.parse(msg.uri);
            await vscode.commands.executeCommand("vscode.open", uri);
            return;
          }

          if (msg.type === "openTrace") {
            await handleOpenTrace(host, deps, msg.uri);
            return;
          }

          if (msg.type === "openDiff") {
            await handleOpenDiff(host, deps, msg.uri, (msg as any).changeId);
            return;
          }

          if (msg.type === "updateDraft") {
            await handleUpdateDraft(host, deps, msg.uri, msg.changeId, msg.newText);
            return;
          }

          if (msg.type === "applySelected") {
            await handleApplySelected(host, deps, msg.uri, msg.changeId, msg.newText);
            return;
          }

          if (msg.type === "discardChange") {
            await handleDiscardChange(host, deps, msg.uri, msg.changeId);
            return;
          }

          if (msg.type === "applyAll") {
            await handleApplyAll(host, deps);
            return;
          }

          if (msg.type === "rollback") {
            await handleRollback(host, deps, msg.stepId);
            return;
          }

          if (msg.type === "clientError") {
            log.error("Edit webview JS error", { text: msg.text, stack: msg.stack });
            this.ui({ type: "error", text: `Webview error: ${msg.text}` }, "webview/clientError");
            return;
          }

          log.warn("EditViewProvider: unknown webview message", { msg });
          this.ui(
            { type: "error", text: `Unknown webview message type: ${(msg as any)?.type ?? "(missing type)"}` },
            "webview/unknownMessage"
          );
        });
      })
    );

    view.webview.html = await this.getHtml(view.webview);

    void this.guard("EditViewProvider.initialLoad", async () => {
      this.ui({ type: "status", text: "Edit UI loaded. Waiting for webview handshake…" }, "initialLoad");
      await this.sendState();
    });
  }

  public async resetHistory(): Promise<void> {
    await this.guard("EditViewProvider.resetHistory", async () => {
      const activeId = this.state.activeRunId;

      // Determine which runs are being removed (so we can clear their proposed-doc cache).
      const runs = Array.isArray(this.state.runs) ? this.state.runs : [];
      const removedRunIds = runs
        .filter((r) => !activeId || r?.id !== activeId)
        .map((r) => r?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);

      if (activeId) {
        // Keep only the active run
        this.state.runs = runs.filter((r) => r?.id === activeId);

        // Keep only steps for the active run (so rollback still works)
        this.state.steps = (this.state.steps ?? []).filter((s) => s?.runId === activeId);

        // If activeRunId points nowhere, drop it defensively
        if (!this.state.runs.some((r) => r.id === activeId)) {
          this.state.activeRunId = null;
          this.state.steps = [];
        }
      } else {
        // No active run -> clear everything
        this.state.runs = [];
        this.state.steps = [];
        this.state.activeRunId = null;
      }

      // Clear proposed content for removed runs (prevents cache bloat).
      for (const rid of removedRunIds) {
        this.proposedProvider.clearProposal(rid);
      }

      await this.sendState();
      this.ui({ type: "clearHistory", text: "Edit history cleared (in-memory)." }, "resetHistory");
    });
  }

  refresh(): void {
    void this.guard("EditViewProvider.refresh", async () => {
      await this.sendState();
    });
  }

  private scheduleSave(): void {
    // v2 UI: in-memory only. Kept to avoid changing every call site.
  }

  private getActiveRun(): RunRecord | null {
    const activeId = this.state?.activeRunId;
    if (!activeId) return null;

    const runs = this.state?.runs;
    if (!Array.isArray(runs) || runs.length === 0) return null;

    return runs.find((r) => r?.id === activeId) ?? null;
  }

  private withBusy(where: string, statusText: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy) {
      this.ui({ type: "error", text: "Busy: another operation is in progress." }, "busyGuard");
      return Promise.resolve();
    }

    this.busy = true;
    this.ui({ type: "status", text: statusText }, "withBusy/status");
    void this.sendState();

    return (async () => {
      try {
        await fn();
      } catch (e: any) {
        log.caught(where, e);
        this.ui({ type: "error", text: `Error: ${e?.message ?? String(e)}` }, "caught");
      } finally {
        this.busy = false;
        this.scheduleSave();
        void this.sendState();
      }
    })();
  }

  private async sendState(): Promise<void> {
    const payload = buildEditViewPayload(this.state, this.busy);
    this.ui({ type: "state", payload }, "sendState");
  }

  private async ensureConfigAndManifest(): Promise<boolean> {
    const ok = await this.guard("EditViewProvider.ensureConfigAndManifest", async () => {
      await this.config.ensure();
      await this.manifest.load();
      return true;
    });
    return ok === true;
  }

  private async getHtml(webview: vscode.Webview): Promise<string> {
    const { html } = await loadWebviewHtmlTemplate(this.context, webview, {
      templatePath: ["media", "views", "editView.html"],
    });
    return html;
  }
}
