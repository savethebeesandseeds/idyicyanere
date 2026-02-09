import * as vscode from "vscode";
import { PlanChangesParams } from "./commons";

function pickWorkspaceUri(params: PlanChangesParams): vscode.Uri | null {
  try {
    const first = params.files?.[0]?.uri;
    const wf = first ? vscode.workspace.getWorkspaceFolder(first) : undefined;
    const root = wf?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    return root ?? null;
  } catch {
    return null;
  }
}

export async function writeReasoningTraceFile(params: PlanChangesParams, trace: any): Promise<vscode.Uri | null> {
  try {
    const root = pickWorkspaceUri(params);
    if (!root) return null;

    const dir = vscode.Uri.joinPath(root, ".idyicyanere", "reasoning_traces");
    await vscode.workspace.fs.createDirectory(dir);

    const name = `reason_trace_${Date.now()}_${Math.random().toString(16).slice(2, 8)}.json`;
    const uri = vscode.Uri.joinPath(dir, name);

    const text = JSON.stringify(trace, null, 2) + "\n";
    const bytes = new TextEncoder().encode(text);
    await vscode.workspace.fs.writeFile(uri, bytes);

    return uri;
  } catch {
    return null;
  }
}
