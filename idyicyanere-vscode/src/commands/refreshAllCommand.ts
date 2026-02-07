import * as vscode from "vscode";
import { log } from "../logging/logger";

export async function runRefreshAllCommand(): Promise<void> {
  log.info("Command: idyicyanere.refreshAll");
  await vscode.commands.executeCommand("idyicyanere.refresh");
}
