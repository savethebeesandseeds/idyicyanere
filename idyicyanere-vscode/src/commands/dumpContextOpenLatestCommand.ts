import { log } from "../logging/logger";
import * as vscode from "vscode";
import { ContextDumpService } from "../export/contextDumpService";

export async function runDumpContextOpenLatestCommand(contextDump: ContextDumpService): Promise<void> {
  log.info("Command: idyicyanere.dumpContextOpenLatest");
  try {
    await contextDump.openLatestOrMostRecent();
  } catch (err) {
    log.caught("Command: idyicyanere.dumpContextOpenLatest", err);
    vscode.window.showErrorMessage("idyicyanere: failed to open latest context dump (see logs).");
  }
}
