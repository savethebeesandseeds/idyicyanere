import * as vscode from "vscode";
import { log } from "../logging/logger";
import { ContextDumpService } from "../export/contextDumpService";
import { DumpTreeNode, normalizeRel } from "../export/contextDumpUtils";
import { loadWebviewHtmlTemplate } from "../views/htmlUtils";

const PERSIST_ENABLED_KEY = "dumpContextPicker.persistEnabled";
const PERSIST_SELECTED_KEY = "dumpContextPicker.selectedUris";

type PickNode = DumpTreeNode & { root: string };

type WebviewIn =
  | { type: "ready" }
  | { type: "children"; parentUri: string }
  | { type: "search"; query: string; limit?: number }
  | { type: "resolveRel"; rel: string }
  | { type: "dump"; selectedUris: string[]; selectedRels: string[] }
  | { type: "cancel" }
  | { type: "saveState"; enabled: boolean; selectedUris: string[] }
  | { type: "clientError"; text: string; stack?: string };

type WebviewOut =
  | {
      type: "roots";
      roots: PickNode[];
      persist: { enabled: boolean; selectedUris: string[]; selectedRels: string[] };
    }
  | { type: "children"; parentUri: string; children: PickNode[] }
  | { type: "searchResults"; query: string; results: PickNode[] }
  | { type: "resolvedRel"; rel: string; uri: string } // empty string if not resolved
  | { type: "status"; text: string }
  | { type: "busy"; busy: boolean; text?: string };

function resolveRelToUri(rel: string): vscode.Uri | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) return null;

  const raw = (rel ?? "").trim().replace(/\\/g, "/");
  if (!raw) return null;

  const parts0 = raw.split("/").filter(Boolean);
  if (!parts0.length) return null;

  if (folders.length === 1) {
    const root = folders[0];
    const parts = parts0[0] === root.name ? parts0.slice(1) : parts0.slice(0);
    return parts.length ? vscode.Uri.joinPath(root.uri, ...parts) : root.uri;
  }

  const rootName = parts0[0];
  const root = folders.find((f) => f.name === rootName);
  if (!root) return null;

  const rest = parts0.slice(1);
  return rest.length ? vscode.Uri.joinPath(root.uri, ...rest) : root.uri;
}

function nodeRootName(uriStr: string): string {
  try {
    const u = vscode.Uri.parse(uriStr);
    const wf = vscode.workspace.getWorkspaceFolder(u);
    return wf?.name ?? "";
  } catch {
    return "";
  }
}

function displayRelForUriStr(uriStr: string): string {
  try {
    const u = vscode.Uri.parse(uriStr);
    const wf = vscode.workspace.getWorkspaceFolder(u);
    if (!wf) return "";

    const root = wf.name;
    const rel = normalizeRel(vscode.workspace.asRelativePath(u, false) || "");
    if (!rel) return root;

    // If asRelativePath already returns "root/..." in some multi-root cases,
    // normalize to exactly root + "/" + path-without-root-prefix.
    const parts = rel.split("/").filter(Boolean);
    const rest = parts[0] === root ? parts.slice(1).join("/") : rel;
    return rest ? `${root}/${rest}` : root;
  } catch {
    return "";
  }
}

function withRoot(nodes: DumpTreeNode[]): PickNode[] {
  return (nodes ?? []).map((n) => ({ ...n, root: nodeRootName(n.uri) || n.name }));
}

async function getHtml(context: vscode.ExtensionContext, webview: vscode.Webview): Promise<string> {
  const { html } = await loadWebviewHtmlTemplate(context, webview, {
    templatePath: ["media", "commands", "dumpContext.html"],
    csp: {},
    substitutions: {},
  });

  return html;
}

export async function runDumpContextCommand(
  context: vscode.ExtensionContext, 
  contextDump: ContextDumpService,
  memento: vscode.Memento
): Promise<void> {
  log.info("Command: idyicyanere.dumpContext (picker modal)");

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    vscode.window.showWarningMessage("idyicyanere: Open a workspace folder first.");
    return;
  }

  const persistEnabled = !!memento.get<boolean>(PERSIST_ENABLED_KEY, false);
  const persistedSelectedUris = memento.get<string[]>(PERSIST_SELECTED_KEY, []) ?? [];
  const persistedSelectedRels = persistedSelectedUris.map(displayRelForUriStr);

  const panel = vscode.window.createWebviewPanel(
    "idyicyanereDumpContextPicker",
    "Dump Context",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
    }
  );

  panel.webview.html = await getHtml(context, panel.webview);

  if (panel.webview.html.includes("${")) {
    log.error("WEBVIEW HTML CONTAINS ${ (likely template interpolation issue)", {
      idx: panel.webview.html.indexOf("${"),
    });
  }

  const post = (m: WebviewOut) => {
    try {
      void panel.webview.postMessage(m);
    } catch {
      // ignore
    }
  };

  let disposed = false;
  panel.onDidDispose(() => {
    disposed = true;
  });

  const guard = async <T>(where: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      log.caught(where, err);
      if (!disposed) post({ type: "status", text: "Error (see logs)." });
      return null;
    }
  };

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    void guard("dumpContextPicker.onDidReceiveMessage", async () => {
      const m = msg as WebviewIn;
      if (!m || typeof (m as any).type !== "string") return;

      // Expand directory selections to files using the dump tree (respects excludes).
      const expandToFiles = async (selected: vscode.Uri[]): Promise<vscode.Uri[]> => {
        const out: vscode.Uri[] = [];
        const seen = new Set<string>();

        const walk = async (u: vscode.Uri): Promise<void> => {
          const key = u.toString();
          if (seen.has(key)) return;
          seen.add(key);

          const kids = await guard("dumpContextPicker.expandToFiles.listChildren", async () =>
            contextDump.listDumpTreeChildren(key)
          );

          // If no children => treat as file (or empty dir).
          if (!kids || kids.length === 0) {
            out.push(u);
            return;
          }

          for (const k of kids) {
            try {
              await walk(vscode.Uri.parse(k.uri));
            } catch {
              // ignore malformed
            }
          }
        };

        for (const u of selected) {
          await walk(u);
        }

        // de-dupe final
        const uniq = new Map<string, vscode.Uri>();
        for (const u of out) uniq.set(u.toString(), u);
        return Array.from(uniq.values());
      };

      if (m.type === "clientError") {
        log.error("dumpContextPicker webview error", { text: m.text, stack: m.stack ?? "" });
        return;
      }

      if (m.type === "cancel") {
        panel.dispose();
        return;
      }

      if (m.type === "ready") {
        post({ type: "busy", busy: true, text: "Loading roots…" });
        const roots = await contextDump.listDumpTreeRoots();
        if (disposed) return;

        post({
          type: "roots",
          roots: withRoot(roots),
          persist: {
            enabled: persistEnabled,
            selectedUris: persistedSelectedUris,
            selectedRels: persistedSelectedRels,
          },
        });

        post({ type: "busy", busy: false });
        return;
      }

      if (m.type === "saveState") {
        const enabled = !!m.enabled;
        const selected = (m.selectedUris ?? []).map(String).filter(Boolean);

        await memento.update(PERSIST_ENABLED_KEY, enabled);

        if (enabled) {
          const uniq = Array.from(new Set(selected));
          await memento.update(PERSIST_SELECTED_KEY, uniq);
        } else {
          await memento.update(PERSIST_SELECTED_KEY, []);
        }
        return;
      }

      if (m.type === "children") {
        const parentUri = String(m.parentUri ?? "");
        if (!parentUri) return;

        const children = await contextDump.listDumpTreeChildren(parentUri);
        if (disposed) return;

        post({ type: "children", parentUri, children: withRoot(children) });
        return;
      }

      if (m.type === "resolveRel") {
        const rel = String(m.rel ?? "");
        const u = resolveRelToUri(rel);
        post({ type: "resolvedRel", rel, uri: u ? u.toString() : "" });
        return;
      }

      if (m.type === "search") {
        const q = String(m.query ?? "").trim();
        const limit = Math.max(1, Math.min(1000, Math.trunc((m as any).limit ?? 300)));
        if (!q) {
          post({ type: "searchResults", query: q, results: [] });
          return;
        }

        post({ type: "busy", busy: true, text: "Searching…" });
        const results = await contextDump.searchDumpTree(q, limit);
        if (disposed) return;

        post({ type: "searchResults", query: q, results: withRoot(results) });
        post({ type: "busy", busy: false });
        return;
      }

      if (m.type === "dump") {
        const selectedUris = (m.selectedUris ?? []).map((s) => String(s)).filter(Boolean);
        const selectedRels = (m.selectedRels ?? []).map((s) => String(s)).filter(Boolean);

        if (!selectedUris.length) {
          post({ type: "status", text: "Nothing selected." });
          return;
        }

        // Close modal immediately (modal UX)
        panel.dispose();

        const uris: vscode.Uri[] = [];
        for (const s of selectedUris) {
          try {
            uris.push(vscode.Uri.parse(s));
          } catch {
            // ignore malformed
          }
        }
        if (!uris.length) return;

        const expandedUris = await expandToFiles(uris);
        if (!expandedUris.length) {
          vscode.window.showWarningMessage("idyicyanere: nothing to dump after expanding selection.");
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Dumping context…", cancellable: true },
          (progress, token) =>
            (async () => {
              try {
                const r = await contextDump.dumpContextFromUris(expandedUris, {
                  progress,
                  token,
                  sourceLabel: "picker modal selection",
                  selectionLabel: selectedRels.join(" "),
                });

                if (r.cancelled) {
                  vscode.window.showWarningMessage("idyicyanere: context dump cancelled.");
                  return;
                }

                vscode.window.showInformationMessage(
                  `idyicyanere: wrote context dump (${r.stats.includedWritten} files, ${r.stats.totalBytesWritten} bytes).`
                );
              } catch (err) {
                log.caught("Command: idyicyanere.dumpContext (picker)", err);
                vscode.window.showErrorMessage("idyicyanere: context dump failed (see logs).");
              }
            })()
        );
      }
    });
  });
}
