import { log } from "../logging/logger";
import * as vscode from "vscode";
import { ContextDumpService } from "../export/contextDumpService";

export async function runDumpContextOpenBackups(contextDump: ContextDumpService): Promise<void> {
  log.info("Command: idyicyanere.dumpContextOpenBackups");
  try {
    await contextDump.openAllBackups();
  } catch (err) {
    log.caught("Command: idyicyanere.dumpContextOpenBackups", err);
    vscode.window.showErrorMessage("idyicyanere: failed to open context dump backups (see logs).");
  }
}
