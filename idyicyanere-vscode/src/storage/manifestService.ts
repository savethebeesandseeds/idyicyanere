import * as vscode from "vscode";
import { StoragePaths } from "./paths";
import { log } from "../logging/logger";

export interface ManifestEntry {
  mtimeMs: number;
  sha256?: string;
  rows: number[];
  chunking?: { method: string; chunkChars: number };
  included?: boolean; // default true
}

export interface ManifestFile {
  version: number;
  files: Record<string, ManifestEntry>;
  freeRows?: number[]; // pool for reusing row IDs
}

const EMPTY: ManifestFile = { version: 2, files: {}, freeRows: [] };

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export class ManifestService {
  private manifest: ManifestFile = { ...EMPTY };

  constructor(private readonly paths: StoragePaths) {}

  async load(): Promise<void> {
    log.debug("ManifestService.load()", { manifestPath: this.paths.manifestUri.toString() });

    if (!(await exists(this.paths.manifestUri))) {
      this.manifest = { ...EMPTY };
      await this.save();
      log.info("manifest.json missing; created new", { manifestPath: this.paths.manifestUri.toString() });
      return;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(this.paths.manifestUri);
      const text = new TextDecoder("utf-8").decode(bytes);
      const parsed = JSON.parse(text) as ManifestFile;

      // Very lightweight validation
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.version !== "number" ||
        typeof parsed.files !== "object"
      ) {
        throw new Error("manifest shape invalid");
      }

      this.manifest = parsed;
      log.info("manifest.json loaded", { files: Object.keys(this.manifest.files).length });
    } catch (err) {
      log.caught("ManifestService.load", err);

      // If corrupted: reset
      this.manifest = { ...EMPTY };
      await this.save();
      vscode.window.showWarningMessage("idyicyanere: manifest.json was invalid; reset.");
    }
  }

  get(key: string): ManifestEntry | undefined {
    return this.manifest.files[key];
  }

  set(key: string, entry: ManifestEntry): void {
    this.manifest.files[key] = entry;
  }

  async reset(reason?: string): Promise<void> {
    this.manifest = { ...EMPTY };
    await this.save();
    log.warn("manifest.json reset", { reason: reason ?? "" });
  }

  delete(key: string): void {
    delete this.manifest.files[key];
  }

  entries(): Array<[string, ManifestEntry]> {
    return Object.entries(this.manifest.files);
  }

  async save(): Promise<void> {
    const text = JSON.stringify(this.manifest, null, 2) + "\n";
    const bytes = new TextEncoder().encode(text);
    await vscode.workspace.fs.writeFile(this.paths.manifestUri, bytes);
    log.debug("ManifestService.save()", { files: Object.keys(this.manifest.files).length });
  }
}
