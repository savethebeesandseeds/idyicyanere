import * as vscode from "vscode";
import * as path from "path";
import { ConfigService } from "../../storage/configService";
import { IndexService } from "../../indexing/indexService";
import { log } from "../../logging/logger";

import { NodeRow, StatusKind, WebviewIn, WebviewOut } from "./filesContract";
import { deriveExcludedSegments, isExcludedRel, normalizeRel } from "./filesUtils";

export type FilesDeps = {
  indexer: IndexService;
  config: ConfigService;
};

export type FilesHost = {
  post(payload: WebviewOut): void;
  status(text: string): void;
  error(text: string): void;
  withProgress(title: string, fn: () => Promise<void>): Promise<void>;
};

async function sendRoots(host: FilesHost, deps: FilesDeps): Promise<void> {
  await deps.config.ensure();

  const folders = vscode.workspace.workspaceFolders ?? [];
  const rows: NodeRow[] = [];

  for (const f of folders) {
    let rootStatus: StatusKind | undefined;
    try {
      rootStatus = await computeFolderStatusRecursive(deps, f.uri, 4000);
    } catch (err) {
      log.caught("computeFolderStatusRecursive(root)", err);
      rootStatus = "error";
    }

    rows.push({
      kind: "root",
      uri: f.uri.toString(),
      name: f.name,
      rel: normalizeRel(f.name),
      status: rootStatus,
    });
  }

  host.post({ type: "roots", rows });
}

function relWithinWorkspace(uri: vscode.Uri): { folder: vscode.WorkspaceFolder | undefined; rel: string } {
  const wf = vscode.workspace.getWorkspaceFolder(uri);
  if (!wf) return { folder: undefined, rel: normalizeRel(vscode.workspace.asRelativePath(uri, false)) };

  // compute path relative to that root, without prefixing the workspace folder name
  const relFs = path.relative(wf.uri.fsPath, uri.fsPath);
  return { folder: wf, rel: normalizeRel(relFs) };
}

function uriForFolder(root: vscode.Uri, relDir: string): vscode.Uri {
  const parts = normalizeRel(relDir).split("/").filter(Boolean);
  let u = root;
  for (const p of parts) u = vscode.Uri.joinPath(u, p);
  return u;
}

async function runSearch(host: FilesHost, deps: FilesDeps, query: string, limit = 2000): Promise<void> {
  await deps.config.ensure();

  const q = (query ?? "").trim().toLowerCase();
  if (!q) {
    await sendRoots(host, deps);
    return;
  }

  const excluded = deps.config.data.indexing.excludeGlobs ?? [];
  const excludeGlob = excluded.length ? `{${excluded.join(",")}}` : undefined;

  // Grab a bounded pool, then filter by substring (simple + effective)
  const maxFind = Math.max(limit * 4, 4000);
  let all: vscode.Uri[] = [];
  try {
    all = await vscode.workspace.findFiles("**/*", excludeGlob, maxFind);
  } catch (err) {
    log.caught("runSearch.findFiles", err);
    host.error("Search failed (see logs).");
    return;
  }

  const matches = all.filter((u) => {
    const { rel } = relWithinWorkspace(u);
    const hay = (rel || "").toLowerCase();
    return hay.includes(q);
  });

  // Parent -> children rows
  const childrenByParent = new Map<string, NodeRow[]>();

  // Track which roots have anything
  const usedRoots = new Set<string>();

  function pushChild(parentUri: string, row: NodeRow) {
    const k = parentUri;
    const arr = childrenByParent.get(k) ?? [];
    arr.push(row);
    childrenByParent.set(k, arr);
  }

  // Also track created folder rows so we don’t duplicate
  const seenNode = new Set<string>();

  // Build nodes (files + all ancestor folders)
  for (const fileUri of matches.slice(0, limit)) {
    const { folder, rel } = relWithinWorkspace(fileUri);
    if (!folder) continue;

    usedRoots.add(folder.uri.toString());

    const parts = normalizeRel(rel).split("/").filter(Boolean);
    if (!parts.length) continue;

    // Ensure folder chain exists and parent->child edges are added
    let parentUri = folder.uri.toString();
    let curRelDir = "";

    for (let i = 0; i < parts.length - 1; i++) {
      curRelDir = curRelDir ? `${curRelDir}/${parts[i]}` : parts[i];
      const folderUri = uriForFolder(folder.uri, curRelDir);
      const folderUriStr = folderUri.toString();

      // create folder node once, and attach to parent
      if (!seenNode.has(folderUriStr)) {
        seenNode.add(folderUriStr);

        pushChild(parentUri, {
          kind: "folder",
          uri: folderUriStr,
          name: parts[i],
          rel: curRelDir,
          // status optional here; you can compute it, but it can be expensive during search
        });
      }

      parentUri = folderUriStr;
    }

    // Now attach the file to its immediate parent folder (or root)
    const leafName = parts[parts.length - 1];

    // status for file (cheap enough; uses indexer)
    const st = await deps.indexer.getStatus(fileUri);

    pushChild(parentUri, {
      kind: "file",
      uri: fileUri.toString(),
      name: leafName,
      rel,
      status: st.kind as StatusKind,
      // optional details (can be omitted for search speed)
      ext: (path.extname(rel) || "").toLowerCase() || "(no ext)",
    });
  }

  // Sort children arrays (folders first, then files)
  for (const [p, rows] of childrenByParent.entries()) {
    rows.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "file" ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    childrenByParent.set(p, rows);
  }

  // Send roots (you can send all roots; I prefer only those with matches)
  const roots = (vscode.workspace.workspaceFolders ?? [])
    .filter((wf) => usedRoots.has(wf.uri.toString()))
    .map((wf) => ({
      kind: "root" as const,
      uri: wf.uri.toString(),
      name: wf.name,
      rel: normalizeRel(wf.name),
    }));

  host.post({ type: "roots", rows: roots });

  // Send children for every parent we constructed (roots + folders)
  for (const [parent, rows] of childrenByParent.entries()) {
    host.post({ type: "children", parent, rows });
  }
}

async function listChildren(deps: FilesDeps, dir: vscode.Uri): Promise<NodeRow[]> {
  await deps.config.ensure();

  const excluded = deriveExcludedSegments(deps.config.data.indexing.excludeGlobs);

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return [];
  }

  // folders first, then files, alphabetical
  entries.sort((a, b) => {
    const ta = a[1];
    const tb = b[1];
    if (ta !== tb) return ta === vscode.FileType.File ? 1 : -1;
    return a[0].localeCompare(b[0]);
  });

  const rows: NodeRow[] = [];

  for (const [name, type] of entries) {
    const child = vscode.Uri.joinPath(dir, name);
    const rel = normalizeRel(vscode.workspace.asRelativePath(child, false));
    if (isExcludedRel(rel, excluded)) continue;

    if (type === vscode.FileType.Directory) {
      let folderStatus: StatusKind | undefined;
      try {
        folderStatus = await computeFolderStatusRecursive(deps, child, 4000);
      } catch (err) {
        log.caught("computeFolderStatusRecursive", err);
        folderStatus = "error";
      }

      rows.push({
        kind: "folder",
        uri: child.toString(),
        name,
        rel,
        status: folderStatus, // aggregated recursive status (may be undefined for empty)
      });
      continue;
    }

    if (type === vscode.FileType.File) {
      let stat: vscode.FileStat | undefined;
      try {
        stat = await vscode.workspace.fs.stat(child);
      } catch {
        stat = undefined;
      }

      const status = await deps.indexer.getStatus(child, stat);
      const used = deps.indexer.getIndexedChunking(child);
      const chunking = used ? `${used.method}(${used.chunkChars})` : "—";

      const ext = (path.extname(rel) || "").toLowerCase() || "(no ext)";
      const sizeBytes = stat?.size ?? 0;

      rows.push({
        kind: "file",
        uri: child.toString(),
        name,
        rel,
        status: status.kind as StatusKind,
        sizeBytes,
        ext,
        chunking,
      });
    }
  }

  return rows;
}

async function sendChildren(host: FilesHost, deps: FilesDeps, parentUri: string): Promise<void> {
  const uri = vscode.Uri.parse(parentUri);
  const rows = await listChildren(deps, uri);
  host.post({ type: "children", parent: parentUri, rows });
}

async function collectFilesRecursive(deps: FilesDeps, baseUri: vscode.Uri, limit = 20000): Promise<vscode.Uri[]> {
  await deps.config.ensure();

  const excluded = deriveExcludedSegments(deps.config.data.indexing.excludeGlobs);
  const out: vscode.Uri[] = [];

  const walk = async (dir: vscode.Uri) => {
    if (out.length >= limit) return;

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }

    for (const [name, type] of entries) {
      if (out.length >= limit) return;

      const child = vscode.Uri.joinPath(dir, name);
      const rel = normalizeRel(vscode.workspace.asRelativePath(child, false));
      if (isExcludedRel(rel, excluded)) continue;

      if (type === vscode.FileType.Directory) {
        await walk(child);
      } else if (type === vscode.FileType.File) {
        out.push(child);
      }
    }
  };

  await walk(baseUri);
  return out;
}

function foldAggStatus(
  cur: { seenIndexed: boolean; seenHidden: boolean },
  st: StatusKind
): { seenIndexed: boolean; seenHidden: boolean; done?: StatusKind } {
  // priority: error > indexing > stale > hidden > indexed > not_indexed
  if (st === "error") return { ...cur, done: "error" };
  if (st === "indexing") return { ...cur, done: "indexing" };
  if (st === "stale") return { ...cur, done: "stale" };

  if (st === "indexed") cur.seenIndexed = true;
  if (st === "hidden") cur.seenHidden = true;

  return cur;
}

function finalizeAggStatus(cur: { seenIndexed: boolean; seenHidden: boolean }, sawAnyFile: boolean): StatusKind | undefined {
  if (!sawAnyFile) return undefined; // empty folder: no hint
  if (cur.seenHidden && !cur.seenIndexed) return "hidden";
  if (cur.seenIndexed) return "indexed";
  return "not_indexed";
}

async function computeFolderStatusRecursive(
  deps: FilesDeps,
  baseUri: vscode.Uri,
  limit = 4000
): Promise<StatusKind | undefined> {
  await deps.config.ensure();

  const excluded = deriveExcludedSegments(deps.config.data.indexing.excludeGlobs);

  let sawAnyFile = false;
  let agg = { seenIndexed: false, seenHidden: false };

  const walk = async (dir: vscode.Uri) => {
    if (limit <= 0) return;

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }

    for (const [name, type] of entries) {
      if (limit <= 0) return;

      const child = vscode.Uri.joinPath(dir, name);
      const rel = normalizeRel(vscode.workspace.asRelativePath(child, false));
      if (isExcludedRel(rel, excluded)) continue;

      if (type === vscode.FileType.Directory) {
        await walk(child);
        continue;
      }

      if (type === vscode.FileType.File) {
        limit--;
        sawAnyFile = true;

        // ask indexer for file status (may stat internally; OK for expanded listings)
        const st = await deps.indexer.getStatus(child);
        agg = foldAggStatus(agg, st.kind as StatusKind);

        if ((agg as any).done) return; // early exit for high-priority states
      }
    }
  };

  await walk(baseUri);

  const done = (agg as any).done as StatusKind | undefined;
  return done ?? finalizeAggStatus(agg, sawAnyFile);
}

async function runFolderBatch(host: FilesHost, deps: FilesDeps, folderUri: vscode.Uri, wantIndex: boolean): Promise<void> {
  const baseRel = vscode.workspace.asRelativePath(folderUri, false);
  const files = await collectFilesRecursive(deps, folderUri, 20000);

  const title = wantIndex ? "Indexing folder…" : "Removing folder from index…";

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${title} ${baseRel}`, cancellable: true },
    (progress, token) => {
      return (async () => {
        try {
          const total = files.length || 1;

          for (let i = 0; i < files.length; i++) {
            if (token.isCancellationRequested) {
              log.info("Bulk op cancelled by user", { title, baseRel, processed: i, total: files.length });
              break;
            }

            const f = files[i];
            const rel = vscode.workspace.asRelativePath(f, false);
            progress.report({ message: `${i + 1}/${total}: ${rel}` });

            const st = await deps.indexer.getStatus(f);

            if (wantIndex) {
              // Reindex stale/not-indexed/hidden; skip already-indexed
              if (st.kind === "indexed") continue;
              await deps.indexer.indexFile(f);
            } else {
              // Hide if present; skip not-indexed
              if (st.kind === "not_indexed") continue;
              await deps.indexer.removeFile(f);
            }
          }
        } catch (err) {
          log.caught(`withProgress(${title} ${baseRel})`, err);
          vscode.window.showErrorMessage(`idyicyanere: ${title} failed (see logs).`);
          throw err; // keep semantics: caller can also handle
        }
      })();
    }
  );
}

async function handleIndexOne(host: FilesHost, deps: FilesDeps, uriStr: string): Promise<void> {
  const uri = vscode.Uri.parse(uriStr);
  const rel = vscode.workspace.asRelativePath(uri, false);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Indexing… ${rel}`, cancellable: false },
    () => {
      return (async () => {
        try {
          // Kick async indexing; refresh roots first so UI can show "indexing" quickly
          const p = deps.indexer.indexFile(uri);
          await sendRoots(host, deps);
          await p;
        } catch (err) {
          log.caught(`withProgress(Indexing… ${rel})`, err);
          host?.error?.(`Indexing failed: ${rel} (see logs).`);
          throw err;
        }
      })();
    }
  );

  await sendRoots(host, deps);
}

async function handleSetHidden(host: FilesHost, deps: FilesDeps, uriStr: string, hidden: boolean): Promise<void> {
  const uri = vscode.Uri.parse(uriStr);
  const rel = vscode.workspace.asRelativePath(uri, false);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${hidden ? "Hiding…" : "Unhiding…"} ${rel}`,
      cancellable: false,
    },
    () => {
      return (async () => {
        try {
          await deps.indexer.setHidden(uri, !!hidden);
        } catch (err) {
          log.caught(`withProgress(${hidden ? "Hiding" : "Unhiding"} ${rel})`, err);
          host?.error?.(`${hidden ? "Hide" : "Unhide"} failed: ${rel} (see logs).`);
          throw err;
        }
      })();
    }
  );

  await sendRoots(host, deps);
}

export async function handleFilesMessage(host: FilesHost, deps: FilesDeps, msg: WebviewIn): Promise<void> {
  if (msg.type === "ready" || msg.type === "refresh") {
    await sendRoots(host, deps);
    return;
  }

  if (msg.type === "getChildren") {
    await sendChildren(host, deps, msg.uri);
    return;
  }

  if (msg.type === "open") {
    const uri = vscode.Uri.parse(msg.uri);
    await vscode.commands.executeCommand("vscode.open", uri);
    return;
  }

  if (msg.type === "search") {
    await runSearch(host, deps, msg.query, msg.limit ?? 2000);
    return;
  }

  if (msg.type === "indexFile" || msg.type === "reindexFile") {
    await handleIndexOne(host, deps, msg.uri);
    return;
  }

  if (msg.type === "setHidden") {
    await handleSetHidden(host, deps, msg.uri, !!msg.hidden);
    return;
  }

  if (msg.type === "folderBatch") {
    const uri = vscode.Uri.parse(msg.uri);
    await runFolderBatch(host, deps, uri, !!msg.wantIndex);
    await sendRoots(host, deps);
    return;
  }

  if (msg.type === "clientError") {
    log.error("Files webview JS error", { text: msg.text, stack: msg.stack });
    return;
  }

  host.error(`Unknown message type: ${(msg as any)?.type ?? "(missing type)"}`);
}

// Export roots/children for provider.refresh() convenience if desired
export const filesApi = { sendRoots };