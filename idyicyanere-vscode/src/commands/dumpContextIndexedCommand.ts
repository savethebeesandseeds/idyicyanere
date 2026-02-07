import * as vscode from "vscode";
import { log } from "../logging/logger";
import { ContextDumpService } from "../export/contextDumpService";

export async function runDumpContextIndexedCommand(contextDump: ContextDumpService): Promise<void> {
  log.info("Command: idyicyanere.dumpContextIndexed");

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Dumping indexed context…", cancellable: true },
    (_progress, token) => {
      return (async () => {
        try {
          const r = await contextDump.dumpContextIndexed({ progress: _progress, token });

          if (r.cancelled) {
            vscode.window.showWarningMessage("idyicyanere: context dump cancelled.");
            return;
          }

          vscode.window.showInformationMessage(
            `idyicyanere: wrote context dump (${r.stats.includedWritten} files, ${r.stats.totalBytesWritten} bytes).`
          );
        } catch (err) {
          log.caught("Command: idyicyanere.dumpContextIndexed", err);
          vscode.window.showErrorMessage("idyicyanere: context dump failed (see logs).");
        }
      })();
    }
  );
}
