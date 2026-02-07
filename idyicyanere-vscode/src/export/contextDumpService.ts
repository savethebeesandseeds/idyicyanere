import * as vscode from "vscode";

import { StoragePaths } from "../storage/paths";
import { ConfigService } from "../storage/configService";
import { ManifestService, ManifestEntry } from "../storage/manifestService";
import { log } from "../logging/logger";

import {
  DumpStats,
  dumpContextIndexedResult,
  DumpWriteOptions,
  DumpWriterItem,
  deriveExcludedSegments,
  exists,
  isAbsoluteFsPath,
  isExcludedRel,
  isProbablyHiddenRel,
  normalizeRel,
  openInEditor,
  pathBaseNoExt,
  pathExt,
  sanitizeSimpleName,
  tsUtcForFilename,
  utcNowString,
  DumpTreeNode
} from "./contextDumpUtils";

import { writeContextDump } from "./contextDumpWriter";

export class ContextDumpService {
  constructor(
    private readonly paths: StoragePaths,
    private readonly config: ConfigService,
    private readonly manifest: ManifestService
  ) {}

  private buildExcludedSegments(): string[] {
    return deriveExcludedSegments([
      ...(this.config.data.indexing?.excludeGlobs ?? []),
      "**/.git/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/.vscode/**",
      "**/context_dumps/**",
    ]);
  }

  private nodeFromUri(u: vscode.Uri, type: vscode.FileType, excludedSegments: string[]): DumpTreeNode {
    const rel = normalizeRel(vscode.workspace.asRelativePath(u, false) || u.fsPath);
    const name = (rel.split("/").pop() || u.path.split("/").pop() || u.toString());
    const hidden = isProbablyHiddenRel(rel);
    const excluded = isExcludedRel(rel, excludedSegments);

    // If hidden is not included, the UI can decide to not show it at all;
    // we still compute flags so UI can render greyed out if desired.
    const kind: "dir" | "file" = (type === vscode.FileType.Directory) ? "dir" : "file";

    return { uri: u.toString(), name, rel, kind, hidden, excluded };
  }

  async dumpContextFromUris(
    selectedUris: vscode.Uri[],
    opts?: {
      progress?: vscode.Progress<{ message?: string; increment?: number }>;
      token?: vscode.CancellationToken;
      sourceLabel?: string;
      selectionLabel?: string; // optional string to print in header
    }
  ): Promise<dumpContextIndexedResult> {
    await this.config.ensure();
    await this.manifest.load();
    const manifestMap = new Map<string, ManifestEntry>(this.manifest.entries());

    const wopts = this.readDumpWriteOptions();
    const { backupsDir, latest } = await this.getDumpUris();
    await this.rotateLatestToBackup(latest, backupsDir);

    const stats = this.makeFreshStats(latest.fsPath);

    const token = opts?.token;
    const report = (message: string) => opts?.progress?.report({ message });

    const excludedSegments = this.buildExcludedSegments();

    const addFile = (u: vscode.Uri, out: vscode.Uri[], seen: Set<string>) => {
      const k = u.toString();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(u);
    };

    const collected: vscode.Uri[] = [];
    const seen = new Set<string>();

    const walkDir = async (dirUri: vscode.Uri): Promise<void> => {
      if (token?.isCancellationRequested) return;

      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(dirUri);
      } catch {
        stats.skippedMissing++;
        return;
      }

      for (const [name, t] of entries) {
        if (token?.isCancellationRequested) return;

        const child = vscode.Uri.joinPath(dirUri, name);
        const rel = normalizeRel(vscode.workspace.asRelativePath(child, false));

        if (!wopts.includeHidden && isProbablyHiddenRel(rel)) {
          stats.skippedHidden++;
          continue;
        }

        if (t === vscode.FileType.Directory) {
          if (isExcludedRel(rel, excludedSegments)) continue;
          await walkDir(child);
          continue;
        }

        if (t === vscode.FileType.File || t === vscode.FileType.SymbolicLink) {
          if (isExcludedRel(rel, excludedSegments)) continue;
          addFile(child, collected, seen);
        }
      }
    };

    report("Resolving selection…");

    for (const u of selectedUris ?? []) {
      if (token?.isCancellationRequested) break;
      if (u.scheme !== "file") {
        stats.skippedMissing++;
        continue;
      }

      let st: vscode.FileStat;
      try {
        st = await vscode.workspace.fs.stat(u);
      } catch {
        stats.skippedMissing++;
        continue;
      }

      const rel = normalizeRel(vscode.workspace.asRelativePath(u, false));
      if (!wopts.includeHidden && isProbablyHiddenRel(rel)) {
        stats.skippedHidden++;
        continue;
      }

      if (st.type === vscode.FileType.Directory) {
        if (!isExcludedRel(rel, excludedSegments)) {
          report(`Scanning folder: ${rel}`);
          await walkDir(u);
        }
      } else if (st.type === vscode.FileType.File || st.type === vscode.FileType.SymbolicLink) {
        addFile(u, collected, seen);
      }
    }

    const items: DumpWriterItem[] = [];
    for (const u of collected) {
      const rel = normalizeRel(vscode.workspace.asRelativePath(u, false) || u.fsPath);
      const key = u.toString();
      const entry = manifestMap.get(key);
      const indexed = !!entry;

      let stale = false;
      if (entry) {
        try {
          const st = await vscode.workspace.fs.stat(u);
          stale = st.mtime !== entry.mtimeMs;
        } catch {
          stale = false;
        }
      }

      const hidden = isProbablyHiddenRel(rel);
      items.push({ uri: u, rel, hidden, indexed, stale });
    }

    items.sort((a, b) => a.rel.localeCompare(b.rel));
    stats.selectedFromUserPaths = items.length; // keep existing stat field for now (no UI break)

    const headerLines: string[] = [
      "# Context dump (idyicyanere)",
      `# Date: ${utcNowString()}`,
      `# Source: ${opts?.sourceLabel ?? "uri selection"}`,
      `# Selection: ${opts?.selectionLabel ?? (selectedUris ?? []).map((x) => x.toString()).join(" ")}`,
      `# Options: noFences=${wopts.noFences}, listOnly=${wopts.listOnly}, maxFileBytes=${wopts.maxFileBytes}, maxTotalBytes=${wopts.maxTotalBytes}`,
    ];

    const { cancelled } = await writeContextDump({
      outputFsPath: latest.fsPath,
      headerLines,
      items,
      stats,
      opts: wopts,
      report: (m) => report(m),
      token,
    });

    // For tree/URI-driven selections, keep an immediate labeled backup.
    // Typed-path wrapper already creates "paths_dump".
    if (!cancelled && opts?.sourceLabel !== "user paths (typed)") {
      await this.copyLatestToBackup(latest, backupsDir, "selection_dump");
    }

    if (this.config.data.contextDump.openAfterDump) {
      try {
        await openInEditor(latest);
      } catch (err) {
        log.caught("ContextDumpService.openAfterDump", err);
      }
    }

    return { outputUri: latest, backupsDir, stats, cancelled };
  }

  async listDumpTreeRoots(): Promise<DumpTreeNode[]> {
    await this.config.ensure();

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) return [];

    const excludedSegments = this.buildExcludedSegments();

    // Roots should display workspace folder name, not derived from rel/asRelativePath.
    return folders.map((f) => {
      const uri = f.uri.toString();
      const name = f.name;
      const rel = f.name; // stable label for UI
      const hidden = false;
      const excluded = false; // roots are not excluded by segment rules
      return { uri, name, rel, kind: "dir", hidden, excluded };
    });
  }

  /**
   * Search across workspace files (flat results) for the picker modal.
   * Returns file nodes only; selection still supports folders via tree mode.
   */
  async searchDumpTree(query: string, limit = 200, maxFind = 8000): Promise<DumpTreeNode[]> {
    await this.config.ensure();

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) return [];

    const q = (query ?? "").trim().toLowerCase();
    if (!q) return [];

    const includeHidden = !!this.config.data.contextDump?.includeHidden;
    const excludedSegments = this.buildExcludedSegments();

    // Exclude globs: user-config + sane defaults
    const excludeParts = [
      ...(this.config.data.indexing?.excludeGlobs ?? []),
      "**/.git/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/.vscode/**",
      "**/context_dumps/**",
    ].filter(Boolean);

    const exclude = `{${Array.from(new Set(excludeParts)).join(",")}}`;

    let files: vscode.Uri[] = [];
    try {
      files = await vscode.workspace.findFiles("**/*", exclude, maxFind);
    } catch {
      return [];
    }

    const out: DumpTreeNode[] = [];

    for (const u of files) {
      const rel = normalizeRel(vscode.workspace.asRelativePath(u, false) || u.fsPath);
      const relLower = rel.toLowerCase();

      if (!includeHidden && isProbablyHiddenRel(rel)) continue;
      if (!relLower.includes(q)) continue;

      const name = (rel.split("/").pop() || u.path.split("/").pop() || u.toString());
      const hidden = isProbablyHiddenRel(rel);
      const excluded = isExcludedRel(rel, excludedSegments);

      out.push({ uri: u.toString(), name, rel, kind: "file", hidden, excluded });

      if (out.length >= limit) break;
    }

    out.sort((a, b) => a.rel.localeCompare(b.rel));
    return out;
  }

  async listDumpTreeChildren(parentUriStr: string): Promise<DumpTreeNode[]> {
    await this.config.ensure();

    const includeHidden = !!this.config.data.contextDump?.includeHidden;
    const excludedSegments = this.buildExcludedSegments();

    let parent: vscode.Uri;
    try {
      parent = vscode.Uri.parse(parentUriStr);
    } catch {
      return [];
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(parent);
    } catch {
      return [];
    }

    const nodes: DumpTreeNode[] = [];

    for (const [name, t] of entries) {
      const child = vscode.Uri.joinPath(parent, name);

      // Filter hidden here (cheap, avoids returning nodes that will be hidden anyway)
      const rel = normalizeRel(vscode.workspace.asRelativePath(child, false) || child.fsPath);
      if (!includeHidden && isProbablyHiddenRel(rel)) continue;

      nodes.push(this.nodeFromUri(child, t, excludedSegments));
    }

    // Directories first, then files; both sorted by rel
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.rel.localeCompare(b.rel);
    });

    return nodes;
  }

  private async getDumpUris(): Promise<{
    baseDir: vscode.Uri;
    backupsDir: vscode.Uri;
    latest: vscode.Uri;
  }> {
    await this.config.ensure();

    const cfg = this.config.data.contextDump;
    const dirName = sanitizeSimpleName(cfg.dirName, "context_dumps");
    const latestFileName = sanitizeSimpleName(cfg.latestFileName, "indexed_context_dump.txt");

    const baseDir = vscode.Uri.joinPath(this.paths.workspaceUri, dirName);
    const backupsDir = vscode.Uri.joinPath(baseDir, "backups");
    const latest = vscode.Uri.joinPath(baseDir, latestFileName);

    await vscode.workspace.fs.createDirectory(baseDir);
    await vscode.workspace.fs.createDirectory(backupsDir);

    return { baseDir, backupsDir, latest };
  }

  private async listBackups(backupsDir: vscode.Uri): Promise<vscode.Uri[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(backupsDir);
    } catch {
      return [];
    }

    const files = entries
      .filter(([, t]) => t === vscode.FileType.File)
      .map(([name]) => vscode.Uri.joinPath(backupsDir, name));

    // sort by mtime ascending (oldest first)
    const withM = await Promise.all(
      files.map(async (u) => {
        try {
          const st = await vscode.workspace.fs.stat(u);
          return { uri: u, mtime: st.mtime };
        } catch {
          return { uri: u, mtime: 0 };
        }
      })
    );

    withM.sort((a, b) => a.mtime - b.mtime);
    return withM.map((x) => x.uri);
  }

  private async rotateLatestToBackup(latest: vscode.Uri, backupsDir: vscode.Uri): Promise<void> {
    await this.config.ensure();
    const keep = Math.max(0, Math.min(50, Math.trunc(this.config.data.contextDump.keepBackups)));

    if (!(await exists(latest))) return;

    const base = pathBaseNoExt(latest.fsPath);
    const ext = pathExt(latest.fsPath) || ".txt";
    const stamp = tsUtcForFilename();

    let backupName = `${base}_${stamp}${ext}`;
    backupName = sanitizeSimpleName(backupName, `dump_${stamp}${ext}`);

    let backupUri = vscode.Uri.joinPath(backupsDir, backupName);

    // Avoid collisions (multiple runs per second)
    for (let i = 1; i <= 50; i++) {
      if (!(await exists(backupUri))) break;
      const n = `${base}_${stamp}_${i}${ext}`;
      backupUri = vscode.Uri.joinPath(backupsDir, sanitizeSimpleName(n, `dump_${stamp}_${i}${ext}`));
    }

    try {
      await vscode.workspace.fs.rename(latest, backupUri, { overwrite: false });
      log.info("Context dump rotated to backup", { backup: backupUri.fsPath });
    } catch (err) {
      log.caught("ContextDumpService.rotateLatestToBackup", err);
      // If rename fails, don't block dump creation.
    }

    // Prune backups (keep last N newest). We sort oldest first; delete extras from front.
    try {
      const backups = await this.listBackups(backupsDir);
      const extra = backups.length - keep;
      if (extra > 0) {
        for (let i = 0; i < extra; i++) {
          await vscode.workspace.fs.delete(backups[i], { recursive: false, useTrash: false });
        }
        log.info("Context dump backups pruned", { keep, deleted: extra });
      }
    } catch (err) {
      log.caught("ContextDumpService.pruneBackups", err);
    }
  }

  private async copyLatestToBackup(latest: vscode.Uri, backupsDir: vscode.Uri, prefix: string): Promise<void> {
    if (!(await exists(latest))) return;

    const ext = pathExt(latest.fsPath) || ".txt";
    const stamp = tsUtcForFilename();

    let backupName = `${prefix}_${stamp}${ext}`;
    backupName = sanitizeSimpleName(backupName, `dump_${stamp}${ext}`);

    let backupUri = vscode.Uri.joinPath(backupsDir, backupName);

    // Avoid collisions
    for (let i = 1; i <= 50; i++) {
      if (!(await exists(backupUri))) break;
      const n = `${prefix}_${stamp}_${i}${ext}`;
      backupUri = vscode.Uri.joinPath(backupsDir, sanitizeSimpleName(n, `dump_${stamp}_${i}${ext}`));
    }

    try {
      await vscode.workspace.fs.copy(latest, backupUri, { overwrite: false });
      log.info("Context dump copied to backup", { backup: backupUri.fsPath, from: latest.fsPath });
    } catch (err) {
      log.caught("ContextDumpService.copyLatestToBackup", err);
    }
  }

  private readDumpWriteOptions(): DumpWriteOptions {
    const cfg = this.config.data.contextDump;
    return {
      includeHidden: !!cfg.includeHidden,
      noFences: !!cfg.noFences,
      listOnly: !!cfg.listOnly,
      maxFileBytes: Math.max(0, Math.trunc(cfg.maxFileBytes)),
      maxTotalBytes: Math.max(0, Math.trunc(cfg.maxTotalBytes)),
    };
  }

  private makeFreshStats(outputFsPath: string): DumpStats {
    return {
      selectedFromManifest: 0,
      selectedFromUserPaths: 0,
      includedWritten: 0,
      skippedMissing: 0,
      skippedBinary: 0,
      skippedHidden: 0,
      truncatedFiles: 0,
      stoppedByMaxTotal: false,
      totalBytesWritten: 0,
      outputFsPath,
    };
  }

  async dumpContextIndexed(opts?: {
    progress?: vscode.Progress<{ message?: string; increment?: number }>;
    token?: vscode.CancellationToken;
  }): Promise<dumpContextIndexedResult> {
    await this.config.ensure();
    await this.manifest.load(); // ensure on-disk is coherent

    const wopts = this.readDumpWriteOptions();
    const { backupsDir, latest } = await this.getDumpUris();

    await this.rotateLatestToBackup(latest, backupsDir);

    const stats = this.makeFreshStats(latest.fsPath);

    const token = opts?.token;
    const report = (message: string) => opts?.progress?.report({ message });

    // Prepare list from manifest
    const items: DumpWriterItem[] = [];
    for (const [key, entry] of this.manifest.entries()) {
      try {
        const uri = vscode.Uri.parse(key);
        if (uri.scheme !== "file") continue;

        const hidden = entry.included === false;
        if (hidden && !wopts.includeHidden) {
          stats.skippedHidden++;
          continue;
        }

        const rel = normalizeRel(vscode.workspace.asRelativePath(uri, false));
        // stale computed by writer from fs stat vs entry? no: we compute here (cheap) per-item
        let stale = false;
        try {
          const st = await vscode.workspace.fs.stat(uri);
          stale = st.mtime !== entry.mtimeMs;
        } catch {
          // missing handled by writer; keep stale=false
        }

        items.push({ uri, rel, hidden, stale, indexed: true });
      } catch {
        continue;
      }
    }

    items.sort((a, b) => a.rel.localeCompare(b.rel));
    stats.selectedFromManifest = items.length;

    const headerLines: string[] = [
      "# Indexed context dump (idyicyanere)",
      `# Date: ${utcNowString()}`,
      `# Source: manifest.json (included${wopts.includeHidden ? "+hidden" : ""})`,
      `# Options: noFences=${wopts.noFences}, listOnly=${wopts.listOnly}, maxFileBytes=${wopts.maxFileBytes}, maxTotalBytes=${wopts.maxTotalBytes}`,
    ];

    const { cancelled } = await writeContextDump({
      outputFsPath: latest.fsPath,
      headerLines,
      items,
      stats,
      opts: wopts,
      report: (m) => report(m),
      token,
    });

    // Footer summary appended after streaming body: do it here (small + simple)
    // (We append by reopening as VS Code fs write is more annoying; easiest is Node append via workspace.fs)
    // But we kept a Node stream writer; simplest is: write summary as an edit at end via workspace.fs is not atomic.
    // Instead: keep summary minimal and rely on stats returned to UI. If you *need* it in-file, tell me and I’ll add it to writer.

    if (this.config.data.contextDump.openAfterDump && !cancelled) {
      try {
        await openInEditor(latest);
      } catch (err) {
        log.caught("ContextDumpService.openAfterDump", err);
      }
    }

    return { outputUri: latest, backupsDir, stats, cancelled };
  }

  /**
   * Dump context for a user-specified set of paths (space-separated in the UI).
   * Paths may be files or folders. Folders are expanded recursively.
   *
   * Refactor: this is now just a thin wrapper:
   *  - resolve user tokens -> vscode.Uri[]
   *  - delegate to dumpContextFromUris() for traversal + writing
   */
  async dumpContextFromPaths(
    userPaths: string[],
    opts?: {
      progress?: vscode.Progress<{ message?: string; increment?: number }>;
      token?: vscode.CancellationToken;
    }
  ): Promise<dumpContextIndexedResult> {
    await this.config.ensure();

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) throw new Error("No workspace folder open.");

    const token = opts?.token;
    const report = (message: string) => opts?.progress?.report({ message });

    // Resolve tokens to URIs (kept as-is; this is the only job of this wrapper now)
    const resolveTokenToUri = (raw: string): vscode.Uri | null => {
      const t0 = (raw ?? "").trim();
      if (!t0) return null;

      // Accept file:// URIs
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t0)) {
        try {
          return vscode.Uri.parse(t0);
        } catch {
          return null;
        }
      }

      const t = t0.replace(/\\/g, "/").replace(/^\.\//, "");
      if (isAbsoluteFsPath(t)) return vscode.Uri.file(t);

      // Multi-root: allow "folderName/path"
      if (folders.length > 1) {
        const parts = t.split("/").filter(Boolean);
        const root = parts[0];
        const hit = folders.find((f) => f.name === root);
        if (hit) {
          const rest = parts.slice(1).join("/");
          return rest ? vscode.Uri.joinPath(hit.uri, rest) : hit.uri;
        }
      }

      return vscode.Uri.joinPath(folders[0].uri, t);
    };

    report("Resolving paths…");

    // Resolve + de-dupe (avoid expanding same folder twice)
    const resolved: vscode.Uri[] = [];
    const seen = new Set<string>();
    for (const p of userPaths ?? []) {
      if (token?.isCancellationRequested) break;

      const u = resolveTokenToUri(p);
      if (!u) continue;

      const k = u.toString();
      if (seen.has(k)) continue;
      seen.add(k);

      resolved.push(u);
    }

    // Delegate to the unified URI-based dumper (folders expanded there).
    const result = await this.dumpContextFromUris(resolved, {
      progress: opts?.progress,
      token,
      sourceLabel: "user paths (typed)",
      selectionLabel: (userPaths ?? []).join(" "),
    });

    // Preserve old behavior: also create an immediate backup labeled "paths_dump"
    // (Even if dumpContextFromUris already copies a generic backup, this keeps compatibility.)
    if (!result.cancelled) {
      try {
        await this.copyLatestToBackup(result.outputUri, result.backupsDir, "paths_dump");
      } catch (err) {
        log.caught("ContextDumpService.dumpContextFromPaths.copyLatestToBackup", err);
      }
    }

    return result;
  }

  async openLatestOrMostRecent(): Promise<void> {
    const { backupsDir, latest } = await this.getDumpUris();

    const backups = await this.listBackups(backupsDir);

    // If latest doesn't exist, open newest backup.
    if (!(await exists(latest))) {
      if (!backups.length) {
        vscode.window.showInformationMessage("idyicyanere: No context dump found yet.");
        return;
      }
      await openInEditor(backups[backups.length - 1]);
      return;
    }

    // If there are backups newer than latest, open newest backup instead.
    try {
      const stLatest = await vscode.workspace.fs.stat(latest);
      const newestBackup = backups.length ? backups[backups.length - 1] : null;
      if (newestBackup) {
        const stB = await vscode.workspace.fs.stat(newestBackup);
        if (stB.mtime > stLatest.mtime) {
          await openInEditor(newestBackup);
          return;
        }
      }
    } catch {
      // fall through to opening latest
    }

    await openInEditor(latest);
  }

  async openAllBackups(): Promise<void> {
    const { backupsDir } = await this.getDumpUris();
    const backups = await this.listBackups(backupsDir);

    if (!backups.length) {
      vscode.window.showInformationMessage("idyicyanere: No context dump backups found.");
      return;
    }

    // open oldest -> newest so newest ends active
    for (const u of backups) await openInEditor(u);
  }
}