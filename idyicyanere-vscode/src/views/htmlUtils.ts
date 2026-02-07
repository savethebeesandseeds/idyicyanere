import * as vscode from "vscode";
import * as fsp from "fs/promises";

export type HtmlTemplateLoadOpts = {
  /**
   * Path segments under extensionUri where the .html template lives.
   * Example: ["dist","views","dbView","dbView.html"]
   */
  templatePath: readonly string[];

  /**
   * Additional substitutions besides __CSP__ and __NONCE__.
   * Values are inserted verbatim (so pass only trusted strings/URIs you control).
   */
  substitutions?: Record<string, string>;

  /**
   * CSP directives appended after "default-src 'none'".
   * If omitted, a sane default is used.
   */
  csp?: {
    imgSrc?: string;   // default: "${webview.cspSource} https: data:"
    styleSrc?: string; // default: "${webview.cspSource} 'unsafe-inline'"
    scriptSrc?: string; // default: "'nonce-${nonce}'"
    fontSrc?: string;  // optional
    connectSrc?: string; // optional
    frameSrc?: string; // optional
    mediaSrc?: string; // optional
  };
};

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * Replaces token everywhere. Throws if token not present at least once.
 * Also throws if replacement is empty and you rely on includes() checks.
 */
function replaceAllStrict(s: string, token: string, value: string): string {
  if (!s.includes(token)) throw new Error(`HTML template missing token: ${token}`);
  return s.split(token).join(value);
}

function buildCsp(webview: vscode.Webview, n: string, csp?: HtmlTemplateLoadOpts["csp"]): string {
  const imgSrc = csp?.imgSrc ?? `${webview.cspSource} https: data:`;
  const styleSrc = csp?.styleSrc ?? `${webview.cspSource} 'unsafe-inline'`;
  const scriptSrc = csp?.scriptSrc ?? `'nonce-${n}'`;

  const parts: string[] = [];
  parts.push(`default-src 'none'`);
  parts.push(`img-src ${imgSrc}`);
  parts.push(`style-src ${styleSrc}`);
  parts.push(`script-src ${scriptSrc}`);

  if (csp?.fontSrc) parts.push(`font-src ${csp.fontSrc}`);
  if (csp?.connectSrc) parts.push(`connect-src ${csp.connectSrc}`);
  if (csp?.frameSrc) parts.push(`frame-src ${csp.frameSrc}`);
  if (csp?.mediaSrc) parts.push(`media-src ${csp.mediaSrc}`);

  return parts.join("; ") + ";";
}

/**
 * Loads an HTML template file and applies standard webview substitutions:
 * - __CSP__   -> computed CSP string
 * - __NONCE__ -> generated nonce
 * plus any caller-provided substitutions.
 */
export async function loadWebviewHtmlTemplate(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  opts: HtmlTemplateLoadOpts
): Promise<{ html: string; nonce: string }> {
  const n = nonce();

  const uri = vscode.Uri.joinPath(context.extensionUri, ...opts.templatePath);
  const raw = await fsp.readFile(uri.fsPath, "utf8");

  const csp = buildCsp(webview, n, opts.csp);

  let html = raw;
  html = replaceAllStrict(html, "__CSP__", csp);
  html = replaceAllStrict(html, "__NONCE__", n);

  const subs = opts.substitutions ?? {};
  for (const [token, value] of Object.entries(subs)) {
    // You decide which tokens must exist. If you want optional tokens,
    // replace this with a non-strict variant for those.
    html = replaceAllStrict(html, token, value);
  }

  return { html, nonce: n };
}
