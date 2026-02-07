import * as vscode from "vscode";

function normalizeRel(rel: string): string {
  return (rel ?? "").replace(/\\/g, "/").trim();
}

function encodePath(rel: string): string {
  return normalizeRel(rel)
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * Virtual document provider used to show diffs in the main editor:
 *   left  = real file
 *   right = idyicyanere-proposed://<proposalId>/<rel path>
 */
export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "idyicyanere-proposed";

  private readonly map = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.map.get(uri.toString()) ?? "";
  }

  makeUri(proposalId: string, rel: string): vscode.Uri {
    const auth = encodeURIComponent(proposalId || "proposal");
    const p = encodePath(rel || "file.txt");
    return vscode.Uri.parse(`${ProposedContentProvider.scheme}://${auth}/${p}`);
  }

  set(uri: vscode.Uri, text: string): void {
    this.map.set(uri.toString(), String(text ?? ""));
    this._onDidChange.fire(uri);
  }

  clearProposal(proposalId: string): void {
    const auth = encodeURIComponent(proposalId || "proposal");
    const prefix = `${ProposedContentProvider.scheme}://${auth}/`;
    for (const k of Array.from(this.map.keys())) {
      if (k.startsWith(prefix)) this.map.delete(k);
    }
  }

  clearAll(): void {
    this.map.clear();
  }
}
