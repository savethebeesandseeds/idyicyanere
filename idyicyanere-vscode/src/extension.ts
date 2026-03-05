import * as vscode from "vscode";
import { StoragePaths } from "./storage/paths";
import { ConfigService } from "./storage/configService";
import { ManifestService } from "./storage/manifestService";
import { OpenAIService } from "./openai/openaiService";
import { IndexService } from "./indexing/indexService";
import { IdyDbStore } from "./storage/idyDbStore";
import { log, registerLogger } from "./logging/logger";
import { ContextDumpService } from "./export/contextDumpService";

import { ChatViewProvider } from "./views/chatView/chatViewProvider";
import { DbViewProvider } from "./views/dbView/dbViewProvider";
import { ConfigViewProvider } from "./views/configView/configViewProvider";
import { CommandsViewProvider } from "./views/commandsView/commandsViewProvider";
import { FilesViewProvider } from "./views/filesView/filesViewProvider";
import { EditViewProvider } from "./views/editView/editViewProvider";
import { ProposedContentProvider } from "./editing/proposedContentProvider";

import { runDumpContextCommand } from "./commands/dumpContextCommand";
import { runDumpContextIndexedCommand } from "./commands/dumpContextIndexedCommand";
import { runDumpContextOpenLatestCommand } from "./commands/dumpContextOpenLatestCommand";
import { runDumpContextOpenBackups } from "./commands/dumpContextOpenBackupsCommand";
import { runRefreshCommand } from "./commands/refreshCommand";
import { runRefreshAllCommand } from "./commands/refreshAllCommand";
import { runOpenConfigCommand } from "./commands/openConfigCommand";
import { runSetApiKeyCommand } from "./commands/setApiKeyCommand";
import { runShowLogsCommand } from "./commands/showLogsCommand";
import { runNukeCommand } from "./commands/nukeCommand";
import { runDebugRagCommand } from "./commands/debugRagCommand";

import { runScienceWritingTensorSymCommand } from "./commands/scienceWritingTensorSymCommand";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function activate(context: vscode.ExtensionContext) {
  try {
    vscode.window.showInformationMessage("idyicyanere activated");

  registerLogger(context);

  let configView: ConfigViewProvider | undefined;

  log.info("activate() starting", {
    extensionId: context.extension.id,
    extensionPath: context.extensionPath,
    workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []
  });

  const paths = await withTimeout(StoragePaths.init(context), 10000, "StoragePaths.init()");

  const config = new ConfigService(paths);
  await withTimeout(config.ensure(), 10000, "ConfigService.ensure()");

  // Apply logging level from config.json
  log.setLevel(config.data.logging.level);
  log.debug("Logging configured from config", { level: config.data.logging.level });

  // Reload config (and logging level) when config.json changes
  const cfgWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(paths.globalUri, "config.json")
  );

  // Keep refs so we can refresh views from watchers/events
  let filesView: FilesViewProvider | undefined;
  let dbView: DbViewProvider | undefined;
  let editView: EditViewProvider | undefined;

  const manifestWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(paths.workspaceUri, "manifest.json")
  );
  manifestWatcher.onDidChange(() => scheduleDbRefresh("manifest changed"));
  manifestWatcher.onDidCreate(() => scheduleDbRefresh("manifest created"));
  manifestWatcher.onDidDelete(() => scheduleDbRefresh("manifest deleted"));
  context.subscriptions.push(manifestWatcher);

  const dbWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(paths.workspaceUri, "idyicyanere.db")
  );
  dbWatcher.onDidChange(() => scheduleDbRefresh("db changed"));
  dbWatcher.onDidCreate(() => scheduleDbRefresh("db created"));
  dbWatcher.onDidDelete(() => scheduleDbRefresh("db deleted"));
  context.subscriptions.push(dbWatcher);

  const reloadConfig = async (reason: string) => {
    try {
      await config.ensure();
      log.setLevel(config.data.logging.level);
      log.info("Config reloaded", { reason, loggingLevel: config.data.logging.level });

      configView?.refresh();

      scheduleDbRefresh(`config ${reason}`);
      scheduleFilesRefresh(`config ${reason}`);
    } catch (err) {
      log.caught(`reloadConfig(${reason})`, err);
    }
  };

  // Debounced refresh so batch indexing doesn’t spam the webview
  let refreshTimer: NodeJS.Timeout | undefined;
  function scheduleDbRefresh(reason: string) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      log.debug("DB refresh scheduled", { reason });
      dbView?.refresh();
    }, 200);
  }

  function scheduleFilesRefresh(reason: string) {
    log.debug("Files refresh scheduled", { reason });
    filesView?.refresh();
  }

  function deriveExcludedSegments(excludeGlobs: string[]): string[] {
    const out: string[] = [];
    for (const g of excludeGlobs ?? []) {
      const m = g.match(/^\*\*\/([^*?[\]{}!]+)\/\*\*$/);
      if (m?.[1]) out.push(m[1]);
    }
    return out;
  }

  function isExcludedRel(rel: string, excludedSegments: string[]): boolean {
    const parts = (rel ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
    for (const seg of excludedSegments) {
      if (parts.includes(seg)) return true;
    }
    return false;
  }

  // --- Mark files as stale immediately when user saves (no reindex) ---
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      try {
        const uri = doc?.uri;
        if (!uri || uri.scheme !== "file") return;
        if (!vscode.workspace.getWorkspaceFolder(uri)) return;

        // Respect excludeGlobs
        const excluded = deriveExcludedSegments(config.data.indexing.excludeGlobs);
        const rel = vscode.workspace.asRelativePath(uri, false);
        if (isExcludedRel(rel, excluded)) return;

        log.debug("Text document saved -> refresh stale UI", { file: rel });

        scheduleDbRefresh("document saved");
        scheduleFilesRefresh("document saved");
      } catch (err) {
        log.caught("onDidSaveTextDocument", err);
      }
    })
  );

  // --- Refresh stale state when workspace files change ---
  const wsWatcher = vscode.workspace.createFileSystemWatcher("**/*");

  function isExcludedByConfig(uri: vscode.Uri): boolean {
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    const excluded = deriveExcludedSegments(config.data.indexing.excludeGlobs);
    return isExcludedRel(rel, excluded);
  }

  async function isRealFile(uri: vscode.Uri): Promise<boolean> {
    try {
      const st = await vscode.workspace.fs.stat(uri);
      return st.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  wsWatcher.onDidChange((uri) => {
    void (async () => {
      if (!vscode.workspace.getWorkspaceFolder(uri)) return;
      if (isExcludedByConfig(uri)) return;
      if (!(await isRealFile(uri))) return;

      scheduleDbRefresh("workspace file changed");
      scheduleFilesRefresh("workspace file changed");
    })();
  });

  wsWatcher.onDidCreate((uri) => {
    void (async () => {
      if (!vscode.workspace.getWorkspaceFolder(uri)) return;
      if (isExcludedByConfig(uri)) return;
      if (!(await isRealFile(uri))) return;

      log.info("Workspace file created -> Refresh All", {
        file: vscode.workspace.asRelativePath(uri, false)
      });

      await vscode.commands.executeCommand("idyicyanere.refresh");
    })();
  });

  wsWatcher.onDidDelete((uri) => {
    void (async () => {
      if (!vscode.workspace.getWorkspaceFolder(uri)) return;
      if (isExcludedByConfig(uri)) return;

      scheduleDbRefresh("workspace file deleted");
      scheduleFilesRefresh("workspace file deleted");
    })();
  });

  context.subscriptions.push(wsWatcher);

  let cfgTimer: NodeJS.Timeout | undefined;

  function scheduleReloadConfig(reason: string) {
    if (cfgTimer) clearTimeout(cfgTimer);
    cfgTimer = setTimeout(() => void reloadConfig(reason), 150);
  }

  cfgWatcher.onDidChange(() => {
    if (config.recentlyWrote()) return;
    scheduleReloadConfig("changed");
  });
  cfgWatcher.onDidCreate(() => {
    if (config.recentlyWrote()) return;
    scheduleReloadConfig("created");
  });
  cfgWatcher.onDidDelete(() => {
    if (config.recentlyWrote()) return;
    scheduleReloadConfig("deleted");
  });

  context.subscriptions.push(cfgWatcher);

  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) clearTimeout(refreshTimer);
    }
  });

  const manifest = new ManifestService(paths);
  await withTimeout(manifest.load(), 10000, "ManifestService.load()");

  const contextDump = new ContextDumpService(paths, config, manifest);

  // Native vector store (IdyDB C++ addon)
  const store = new IdyDbStore(context, paths.dbPath);
  await withTimeout(store.open(), 15000, "IdyDbStore.open()");

  const openai = new OpenAIService(context, config);
  const indexer = new IndexService(config, manifest, store, openai);

  // Proposed-content provider for main-editor diffs
  const proposedProvider = new ProposedContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ProposedContentProvider.scheme, proposedProvider)
  );

  // Free-row pool initialization (unchanged)
  const used = new Set<number>();
  for (const [, entry] of manifest.entries()) {
    for (const r of entry.rows ?? []) used.add(r);
  }

  const nextRow = await withTimeout(store.getNextRow(), 10000, "IdyDbStore.getNextRow()"); // rows are 1..nextRow-1 potentially used/holes
  const free: number[] = [];

  // Efficient gap-finding: sort used rows and fill gaps
  const sorted = Array.from(used)
    .filter((n) => n > 0 && n < nextRow)
    .sort((a, b) => a - b);
  let cur = 1;
  for (const r of sorted) {
    while (cur < r) free.push(cur++);
    cur = r + 1;
  }
  while (cur < nextRow) free.push(cur++);

  store.releaseRows(free);

  // Files webview view (replaces TreeView)
  filesView = new FilesViewProvider(
    context, 
    context.extensionUri, 
    indexer, 
    config);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("idyicyanereFiles", filesView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Edit (Diff) webview view
  editView = new EditViewProvider(
    context, 
    context.extensionUri, 
    config, 
    manifest, 
    openai, 
    proposedProvider, 
    store, 
    indexer);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("idyicyanereEdit", editView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Commands view
  const commandsView = new CommandsViewProvider(
    context, 
    context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("idyicyanereCommands", commandsView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Chat webview view
  const chatView = new ChatViewProvider(
    context, 
    context.extensionUri, 
    store, 
    config, 
    openai, 
    indexer);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("idyicyanereChat", chatView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  let pdfViewType: string | undefined;
  let runOpenPdf:
    | ((viewType: string, uri?: vscode.Uri) => Promise<void>)
    | undefined;
  let pdfProviderRegistered = false;

  const ensurePdfFeatureLoaded = async (): Promise<boolean> => {
    if (pdfProviderRegistered && pdfViewType && runOpenPdf) return true;

    try {
      const [pdfProviderMod, openPdfMod] = await Promise.all([
        import("./views/pdfView/pdfCustomEditorProvider"),
        import("./commands/openPdfCommand")
      ]);

      const Provider = pdfProviderMod.PdfCustomEditorProvider as {
        new (ctx: vscode.ExtensionContext): vscode.CustomReadonlyEditorProvider<vscode.CustomDocument>;
        viewType: string;
      };

      if (!Provider || typeof Provider.viewType !== "string") {
        throw new Error("Invalid PdfCustomEditorProvider export");
      }

      if (typeof openPdfMod.runOpenPdfCommand !== "function") {
        throw new Error("Invalid runOpenPdfCommand export");
      }

      pdfViewType = Provider.viewType;
      runOpenPdf = openPdfMod.runOpenPdfCommand;

      if (!pdfProviderRegistered) {
        context.subscriptions.push(
          vscode.window.registerCustomEditorProvider(
            pdfViewType,
            new Provider(context),
            {
              webviewOptions: { retainContextWhenHidden: true },
              supportsMultipleEditorsPerDocument: true
            }
          )
        );
        pdfProviderRegistered = true;
      }

      return true;
    } catch (err) {
      log.caught("ensurePdfFeatureLoaded", err);
      return false;
    }
  };

  // Lazy-load PDF feature in background; activation continues even if PDF feature fails.
  void ensurePdfFeatureLoaded();

  // --- Commands (moved to per-command files) ---

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.dumpContext.Indexed", async () => {
      await runDumpContextIndexedCommand(contextDump);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.dumpContext.PickModal", async () => {
      await runDumpContextCommand(context, contextDump, context.workspaceState);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.dumpContext.OpenLatest", async () => {
      await runDumpContextOpenLatestCommand(contextDump);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.dumpContext.OpenBackups", async () => {
      await runDumpContextOpenBackups(contextDump);
    })
  );

  // IMPORTANT: DB -> Files sync callback
  const syncAfterIndexMutation = (_uri?: vscode.Uri) => {
    scheduleFilesRefresh("db view mutated index");
  };

  dbView = new DbViewProvider(
    context,
    context.extensionUri,
    paths,
    manifest,
    indexer,
    store,
    config,
    openai,
    syncAfterIndexMutation
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("idyicyanereDb", dbView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.refresh", () => {
      runRefreshCommand({ filesView, chatView, editView, dbView, configView });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.refreshAll", async () => {
      await runRefreshAllCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.openConfig", async () => {
      await runOpenConfigCommand(config);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.setApiKey", async () => {
      await runSetApiKeyCommand(openai);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.showLogs", () => {
      runShowLogsCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.nuke", async () => {
      await runNukeCommand({
        paths,
        config,
        manifest,
        store,
        indexer,
        editView,
        refresh: { filesView, chatView, editView, dbView, configView }
      });
    })
  );

  context.subscriptions.push({
    dispose: async () => {
      log.info("Extension disposing; closing store");
      await store.close();
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.debugRag", async () => {
      await runDebugRagCommand({ indexer, store, openai, config });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.sciencewriting.tensorSym", () =>
      runScienceWritingTensorSymCommand(context, context.globalState)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("idyicyanere.openPdf", async (uri?: vscode.Uri) => {
      const ok = await ensurePdfFeatureLoaded();
      if (!ok || !runOpenPdf || !pdfViewType) {
        vscode.window.showErrorMessage(
          "idyicyanere: PDF viewer could not be initialized in this environment."
        );
        return;
      }
      await runOpenPdf(pdfViewType, uri);
    })
  );

  configView = new ConfigViewProvider(
    context, 
    context.extensionUri, 
    paths, 
    config, 
    openai);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("idyicyanereConfig", configView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

    log.info("activate() complete");
  } catch (err) {
    log.caught("activate()", err);
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`idyicyanere failed to activate: ${msg}`);
    throw err;
  }
}
