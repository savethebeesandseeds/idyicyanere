import * as vscode from "vscode";

export class StoragePaths {
  public readonly workspaceUri: vscode.Uri;
  public readonly globalUri: vscode.Uri;

  public readonly dbUri: vscode.Uri;
  public readonly manifestUri: vscode.Uri;
  public readonly configUri: vscode.Uri;

  // Migration helper: old per-workspace config location
  public readonly legacyWorkspaceConfigUri: vscode.Uri;

  /** Native addon wants a filesystem path string (not a vscode.Uri). */
  public readonly dbPath: string;

  private constructor(workspaceUri: vscode.Uri, globalUri: vscode.Uri) {
    this.workspaceUri = workspaceUri;
    this.globalUri = globalUri;

    this.dbUri = vscode.Uri.joinPath(workspaceUri, "idyicyanere.db");
    this.manifestUri = vscode.Uri.joinPath(workspaceUri, "manifest.json");
    this.legacyWorkspaceConfigUri = vscode.Uri.joinPath(workspaceUri, "config.json");

    // global config
    this.configUri = vscode.Uri.joinPath(globalUri, "config.json");

    this.dbPath = this.dbUri.fsPath;
  }

  /**
   * Uses workspace storage when a folder is open (recommended).
   * Falls back to global storage for no-folder windows.
   */
  static async init(context: vscode.ExtensionContext): Promise<StoragePaths> {
    const workspaceUri = context.storageUri ?? context.globalStorageUri;
    const globalUri = context.globalStorageUri;

    await vscode.workspace.fs.createDirectory(workspaceUri);
    await vscode.workspace.fs.createDirectory(globalUri);

    return new StoragePaths(workspaceUri, globalUri);
  }
}
