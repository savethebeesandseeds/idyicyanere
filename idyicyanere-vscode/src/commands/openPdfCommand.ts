import * as vscode from "vscode";
import { log } from "../logging/logger";

function isPdfUri(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith(".pdf");
}

async function pickPdfFromDisk(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { PDF: ["pdf"] },
    openLabel: "Open PDF with idyicyanere"
  });

  return picked?.[0];
}

export async function runOpenPdfCommand(viewType: string, uriArg?: vscode.Uri): Promise<void> {
  let target = uriArg;

  if (!target) {
    const active = vscode.window.activeTextEditor?.document?.uri;
    if (active && isPdfUri(active)) {
      target = active;
    }
  }

  if (!target) {
    target = await pickPdfFromDisk();
  }

  if (!target) return;

  if (!isPdfUri(target)) {
    vscode.window.showWarningMessage("idyicyanere: Please select a .pdf file.");
    return;
  }

  log.info("Command: idyicyanere.openPdf", { uri: target.toString() });

  await vscode.commands.executeCommand("vscode.openWith", target, viewType, {
    preview: false
  });
}
