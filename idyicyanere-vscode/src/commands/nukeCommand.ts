import * as vscode from "vscode";
import { log } from "../logging/logger";
import { StoragePaths } from "../storage/paths";
import { ConfigService } from "../storage/configService";
import { ManifestService } from "../storage/manifestService";
import { IdyDbStore } from "../storage/idyDbStore";

type IndexerLike = { getIndexingCount: () => number };
type EditViewLike = { resetHistory: () => Promise<void> };

async function existsUri(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

type Refreshables = {
  filesView?: { refresh: () => void };
  chatView?: { refresh: () => void };
  editView?: { refresh: () => void };
  dbView?: { refresh: () => void };
  configView?: { refresh: () => void };
};

export async function runNukeCommand(args: {
  paths: StoragePaths;
  config: ConfigService;
  manifest: ManifestService;
  store: IdyDbStore;
  indexer: IndexerLike;
  editView?: EditViewLike;
  refresh: Refreshables;
}): Promise<void> {
  log.info("Command: idyicyanere.nuke");

  const inflight = args.indexer.getIndexingCount();
  if (inflight > 0) {
    vscode.window.showWarningMessage(
      `idyicyanere: Cannot nuke while indexing is running (${inflight} in progress).`
    );
    return;
  }

  await args.config.ensure();

  const typed = await vscode.window.showInputBox({
    prompt: "This wont delete the project files, would only reset idyicyanere: Type NUKE to confirm",
    ignoreFocusOut: true
  });
  if ((typed ?? "").trim().toLowerCase() !== "nuke") {
    vscode.window.showInformationMessage("idyicyanere: Nuke cancelled.");
    return;
  }

  const dumpDirName = (args.config.data.contextDump?.dirName ?? "context_dumps").trim() || "context_dumps";
  const dumpDir = vscode.Uri.joinPath(args.paths.workspaceUri, dumpDirName);
  const defaultDumpDir = vscode.Uri.joinPath(args.paths.workspaceUri, "context_dumps");

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "idyicyanere: Nuking workspace DB…", cancellable: false },
    (progress) => {
      return (async () => {
        try {
          progress.report({ message: "Closing DB…" });
          await args.store.close();
          args.store.resetFreePool();

          progress.report({ message: "Deleting DB + manifest…" });
          if (await existsUri(args.paths.dbUri)) {
            await vscode.workspace.fs.delete(args.paths.dbUri, { recursive: false, useTrash: false });
          }
          if (await existsUri(args.paths.manifestUri)) {
            await vscode.workspace.fs.delete(args.paths.manifestUri, { recursive: false, useTrash: false });
          }

          progress.report({ message: "Deleting context dump files…" });
          if (await existsUri(dumpDir)) {
            await vscode.workspace.fs.delete(dumpDir, { recursive: true, useTrash: false });
          }
          if (defaultDumpDir.toString() !== dumpDir.toString() && (await existsUri(defaultDumpDir))) {
            await vscode.workspace.fs.delete(defaultDumpDir, { recursive: true, useTrash: false });
          }

          progress.report({ message: "Recreating empty DB + manifest…" });
          await args.store.open();
          await args.manifest.load();

          progress.report({ message: "Deleting edit history…" });
          if (args.editView) await args.editView.resetHistory();

          progress.report({ message: "Refreshing UI…" });
          args.refresh.filesView?.refresh();
          args.refresh.chatView?.refresh();
          args.refresh.editView?.refresh();
          args.refresh.dbView?.refresh();
          args.refresh.configView?.refresh();

          log.info("Nuke complete", {
            db: args.paths.dbUri.fsPath,
            manifest: args.paths.manifestUri.fsPath,
            dumpDir: dumpDir.fsPath
          });

          vscode.window.showInformationMessage("idyicyanere: Nuke complete (fresh workspace DB).");
        } catch (err) {
          log.caught("Command: idyicyanere.nuke", err);
          vscode.window.showErrorMessage("idyicyanere: Nuke failed (see logs).");

          try {
            await args.store.open();
          } catch (e2) {
            log.caught("Command: idyicyanere.nuke reopen", e2);
          }
        }
      })();
    }
  );
}
