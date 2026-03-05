import * as vscode from "vscode";
import { log } from "../logging/logger";

const HISTORY_KEY = "scienceWriting.tensorSym.history.v2";
const MAX_HISTORY = 250;

export interface TensorSymArgs {
  topLeft: string;
  bottomLeft: string;
  center: string;
  topRight: string;
  bottomRight: string;
}

type WebviewIn =
  | { type: "ready" }
  | { type: "dump"; args: TensorSymArgs }
  | { type: "cancel" }
  | { type: "clientError"; text: string; stack?: string };

type WebviewOut =
  | { type: "init"; history: TensorSymArgs[]; macroCallName: string }
  | { type: "status"; text: string; isError?: boolean };

function getNonce(): string {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(uri);
  } catch {
    // ignore
  }
}

function norm(s: unknown): string {
  return String(s ?? "").replace(/\r?\n/g, " ").trim();
}

function hasBadDelimiter(s: string): boolean {
  // SAFE NOTATION: commas and ')' break the delimiter-parsed macro
  return /[,\)]/.test(s);
}

function validateArgs(a: TensorSymArgs): string | null {
  const fields: Array<[string, string]> = [
    ["center", norm(a.center)],
    ["top_left", norm(a.topLeft)],
    ["bottom_left", norm(a.bottomLeft)],
    ["top_right", norm(a.topRight)],
    ["bottom_right", norm(a.bottomRight)]
  ];

  for (const [name, v] of fields) {
    if (hasBadDelimiter(v)) {
      return `Illegal character in ${name}. SAFE NOTATION forbids ',' and ')'.`;
    }
  }
  return null;
}

function sameArgs(a: TensorSymArgs, b: TensorSymArgs): boolean {
  return (
    norm(a.center) === norm(b.center) &&
    norm(a.topLeft) === norm(b.topLeft) &&
    norm(a.bottomLeft) === norm(b.bottomLeft) &&
    norm(a.topRight) === norm(b.topRight) &&
    norm(a.bottomRight) === norm(b.bottomRight)
  );
}

function buildMacroCall(macroCallName: string, a: TensorSymArgs): string {
  const c = norm(a.center) || "A";
  const tl = norm(a.topLeft);
  const bl = norm(a.bottomLeft);
  const tr = norm(a.topRight);
  const br = norm(a.bottomRight);
  return macroCallName + "(" + [c, tl, bl, tr, br].join(",") + ")";
}

function pickWorkspaceFolder(editor: vscode.TextEditor): vscode.WorkspaceFolder | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) return null;
  return vscode.workspace.getWorkspaceFolder(editor.document.uri) ?? folders[0];
}

async function ensureWorkspaceMacros(context: vscode.ExtensionContext, editor: vscode.TextEditor): Promise<void> {
  const wf = pickWorkspaceFolder(editor);
  if (!wf) return;

  const idyDir = vscode.Uri.joinPath(wf.uri, ".idyicyanere");
  const dst = vscode.Uri.joinPath(idyDir, "idyicyanere-macros.tex");

  if (await exists(dst)) return;

  const src = vscode.Uri.joinPath(context.extensionUri, "media", "latex", "idyicyanere-macros.tex");

  try {
    await ensureDir(idyDir);
    const bytes = await vscode.workspace.fs.readFile(src);
    await vscode.workspace.fs.writeFile(dst, bytes);
    log.info("Copied bundled macros into workspace", { dst: dst.toString() });
  } catch (err) {
    log.caught("ensureWorkspaceMacros", err);
  }
}

async function getHtml(context: vscode.ExtensionContext, webview: vscode.Webview): Promise<string> {
  const tplUri = vscode.Uri.joinPath(context.extensionUri, "media", "commands", "tensorSym.html");
  const raw = await vscode.workspace.fs.readFile(tplUri);
  let html = new TextDecoder("utf-8").decode(raw);

  const nonce = getNonce();
  const csp =
    "default-src 'none'; " +
    "img-src " +
    webview.cspSource +
    " data:; " +
    "style-src " +
    webview.cspSource +
    " 'unsafe-inline'; " +
    "script-src 'nonce-" +
    nonce +
    "';";

  html = html.replace(/__CSP__/g, csp).replace(/__NONCE__/g, nonce);

  if (html.includes("__CSP__") || html.includes("__NONCE__")) {
    log.error("tensorSym.html placeholders were not fully replaced", {
      hasCsp: html.includes("__CSP__"),
      hasNonce: html.includes("__NONCE__")
    });
  }

  if (html.includes("${")) {
    log.error("WEBVIEW HTML CONTAINS ${ (template interpolation risk)", {
      idx: html.indexOf("${")
    });
  }

  return html;
}

/**
 * Apply insertion edits without relying on a live TextEditor (robust vs webview replacing/closing editors).
 */
async function insertAtTarget(
  targetUri: vscode.Uri,
  fallbackSelections: vscode.Selection[],
  callText: string
): Promise<{ applied: boolean; usedLiveSelections: boolean }> {
  const doc = await vscode.workspace.openTextDocument(targetUri);

  const liveEditor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === targetUri.toString()
  );

  const usedLiveSelections = !!(liveEditor?.selections?.length);

  const sels = (usedLiveSelections ? liveEditor!.selections : fallbackSelections).map(
    (s) => new vscode.Range(s.start, s.end)
  );

  // Replace bottom-to-top so offsets don't shift
  sels.sort((a, b) => doc.offsetAt(b.start) - doc.offsetAt(a.start));

  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.set(
    targetUri,
    sels.map((r) => vscode.TextEdit.replace(r, callText))
  );

  const applied = await vscode.workspace.applyEdit(wsEdit);
  return { applied, usedLiveSelections };
}

export async function runScienceWritingTensorSymCommand(
  context: vscode.ExtensionContext,
  memento: vscode.Memento
): Promise<void> {
  log.info("Command: idyicyanere.sciencewriting.tensorSym");

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("idyicyanere: Open a text editor to insert a tensor symbol.");
    return;
  }

  // Snapshot target before opening webview
  const targetUri = editor.document.uri;
  const targetViewColumn = editor.viewColumn ?? vscode.ViewColumn.Active;
  const targetSelections = editor.selections.map((s) => new vscode.Selection(s.start, s.end));
  const targetVersion = editor.document.version; // debug only

  const macroCallName = "\\tensorSym";

  await ensureWorkspaceMacros(context, editor);

  const history = (memento.get<TensorSymArgs[]>(HISTORY_KEY, []) ?? []).filter((x) => !!x && typeof x === "object");

  // Open beside: keeps original editor tab visible
  const panel = vscode.window.createWebviewPanel(
    "idyicyanereTensorSym",
    "Tensor Symbol",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: false }
  );

  panel.webview.html = await getHtml(context, panel.webview);

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
      if (!disposed) post({ type: "status", text: "Error (see logs).", isError: true });
      return null;
    }
  };

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    void guard("tensorSym.onDidReceiveMessage", async () => {
      const m = msg as WebviewIn;
      if (!m || typeof (m as any).type !== "string") return;

      if (m.type === "clientError") {
        log.error("tensorSym webview error", { text: m.text, stack: m.stack ?? "" });
        return;
      }

      if (m.type === "cancel") {
        panel.dispose();
        return;
      }

      if (m.type === "ready") {
        post({ type: "init", history, macroCallName });
        return;
      }

      if (m.type === "dump") {
        const a0 = m.args ?? ({} as any);

        const args: TensorSymArgs = {
          topLeft: norm(a0.topLeft),
          bottomLeft: norm(a0.bottomLeft),
          center: norm(a0.center) || "A",
          topRight: norm(a0.topRight),
          bottomRight: norm(a0.bottomRight)
        };

        const err = validateArgs(args);
        if (err) {
          post({ type: "status", text: err, isError: true });
          return;
        }

        const call = buildMacroCall(macroCallName, args);

        const { applied, usedLiveSelections } = await insertAtTarget(targetUri, targetSelections, call);
        if (!applied) {
          post({ type: "status", text: "Insert failed (workspace edit rejected).", isError: true });
          return;
        }

        // update history: unique, most-recent first
        const prev = memento.get<TensorSymArgs[]>(HISTORY_KEY, []) ?? [];
        const next: TensorSymArgs[] = [];
        for (const it of prev) {
          if (!it) continue;
          if (sameArgs(it, args)) continue;
          next.push(it);
        }
        next.unshift(args);
        if (next.length > MAX_HISTORY) next.length = MAX_HISTORY;
        await memento.update(HISTORY_KEY, next);

        // bring doc to focus again
        try {
          const doc = await vscode.workspace.openTextDocument(targetUri);
          await vscode.window.showTextDocument(doc, {
            preview: false,
            preserveFocus: false,
            viewColumn: targetViewColumn
          });
        } catch {
          // ignore
        }

        log.debug("tensorSym inserted", {
          target: targetUri.toString(),
          targetVersion,
          usedLiveSelections
        });

        panel.dispose();
      }
    });
  });
}
