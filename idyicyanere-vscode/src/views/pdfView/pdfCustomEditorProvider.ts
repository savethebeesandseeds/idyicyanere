import * as vscode from "vscode";
import * as path from "path";
import { createHash } from "crypto";
import { log } from "../../logging/logger";
import { extractPdfTextPreview } from "./pdfTextPreview";

type ActiveContentMarker = {
  token: string;
  label: string;
  description: string;
};

type ResolveState = {
  blocked: boolean;
  findings: ActiveContentMarker[];
  scanError: string | null;
  blockActiveContent: boolean;
  previewPages: string[];
  previewWarnings: string[];
  pdfResource: string;
  fileSizeBytes: number;
  modifiedIso: string | null;
  sha256: string;
  md5: string;
};

class PdfDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}

  dispose(): void {
    // Readonly document; nothing to dispose.
  }
}

const ACTIVE_CONTENT_MARKERS: ActiveContentMarker[] = [
  {
    token: "/JavaScript",
    label: "JavaScript action",
    description: "Embedded JavaScript action dictionary"
  },
  {
    token: "/JS",
    label: "JavaScript source",
    description: "JavaScript code entry"
  },
  {
    token: "/AA",
    label: "Additional actions",
    description: "Automatic actions that can trigger scripts or launch behavior"
  },
  {
    token: "/OpenAction",
    label: "Open action",
    description: "Action triggered when document opens"
  },
  {
    token: "/Launch",
    label: "Launch action",
    description: "Instruction to launch external applications/files"
  },
  {
    token: "/RichMedia",
    label: "Rich media",
    description: "Embedded interactive/rich media payload"
  },
  {
    token: "/SubmitForm",
    label: "Submit form",
    description: "Form submission action"
  },
  {
    token: "/ImportData",
    label: "Import data",
    description: "Action importing external data"
  }
];

const BLOCK_ACTIVE_CONTENT_SETTING = "pdfViewer.blockActiveContent";
const PDFJS_CDN_MAIN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
const PDFJS_CDN_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function uniqueByToken(items: ActiveContentMarker[]): ActiveContentMarker[] {
  const seen = new Set<string>();
  const out: ActiveContentMarker[] = [];
  for (const it of items) {
    const key = it.token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const fixed = value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${fixed} ${units[idx]}`;
}

export class PdfCustomEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  public static readonly viewType = "idyicyanere.pdfViewer";

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<PdfDocument> {
    return new PdfDocument(uri);
  }

  async resolveCustomEditor(
    document: PdfDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const pdfDir = vscode.Uri.file(path.dirname(document.uri.fsPath));

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [pdfDir, this.context.extensionUri]
    };

    const blockActiveContent = vscode.workspace
      .getConfiguration("idyicyanere")
      .get<boolean>(BLOCK_ACTIVE_CONTENT_SETTING, false);

    const state: ResolveState = {
      blocked: false,
      findings: [],
      scanError: null,
      blockActiveContent,
      previewPages: [],
      previewWarnings: [],
      pdfResource: webviewPanel.webview.asWebviewUri(document.uri).toString(),
      fileSizeBytes: 0,
      modifiedIso: null,
      sha256: "",
      md5: ""
    };

    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      const stat = await vscode.workspace.fs.stat(document.uri);
      const raw = Buffer.from(bytes).toString("latin1");
      state.findings = this.scanForActiveContent(raw);
      state.fileSizeBytes = bytes.byteLength;
      state.modifiedIso = stat.mtime ? new Date(stat.mtime).toISOString() : null;
      try {
        state.sha256 = createHash("sha256").update(bytes).digest("hex");
      } catch {
        state.sha256 = "Unavailable";
      }
      try {
        state.md5 = createHash("md5").update(bytes).digest("hex");
      } catch {
        state.md5 = "Unavailable";
      }

      // Build fallback content up-front. Used when CDN is unavailable or render fails.
      const preview = extractPdfTextPreview(bytes);
      state.previewPages = preview.pages;
      state.previewWarnings = preview.warnings;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.scanError = msg;
      log.caught("PdfCustomEditorProvider.scanForActiveContent", err);
    }

    const hasRisk = state.scanError !== null || state.findings.length > 0;
    state.blocked = state.blockActiveContent && hasRisk;

    if (state.blocked) {
      log.warn("PDF blocked due to active content risk markers", {
        uri: document.uri.toString(),
        markers: state.findings.map((f) => f.token),
        scanError: state.scanError
      });
    } else {
      log.info("PDF viewer opened", {
        uri: document.uri.toString(),
        findings: state.findings.length,
        fallbackPages: state.previewPages.length,
        fallbackWarnings: state.previewWarnings.length,
        secureBlocking: state.blockActiveContent
      });
    }

    webviewPanel.webview.html = this.renderHtml(webviewPanel.webview, document.uri, state);
  }

  private scanForActiveContent(text: string): ActiveContentMarker[] {
    const found: ActiveContentMarker[] = [];
    for (const marker of ACTIVE_CONTENT_MARKERS) {
      if (text.includes(marker.token)) found.push(marker);
    }
    return uniqueByToken(found);
  }

  private renderFallback(state: ResolveState): string {
    const warnings = state.previewWarnings.length
      ? `
      <section class="warn">
        <h3>Fallback parser warnings</h3>
        <ul>
          ${state.previewWarnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}
        </ul>
      </section>
      `
      : "";

    const pages = state.previewPages.length
      ? state.previewPages
          .map(
            (page, i) => `
        <section class="fallback-page">
          <h3>Fallback page ${i + 1}</h3>
          <pre>${escapeHtml(page || "(No extractable text detected on this page.)")}</pre>
        </section>
      `
          )
          .join("")
      : `
      <section class="warn">
        <h3>No fallback text available</h3>
        <p>The native fallback parser could not extract text from this PDF.</p>
      </section>
      `;

    return `
      ${warnings}
      ${pages}
    `;
  }

  private renderHtml(webview: vscode.Webview, pdfUri: vscode.Uri, state: ResolveState): string {
    const n = nonce();
    const title = escapeHtml(pdfUri.path.split("/").pop() || "PDF");
    const safePdfResource = escapeHtml(state.pdfResource);
    const safeMain = escapeHtml(PDFJS_CDN_MAIN);
    const safeWorker = escapeHtml(PDFJS_CDN_WORKER);
    const exactSize = state.fileSizeBytes > 0 ? `${state.fileSizeBytes.toLocaleString("en-US")} bytes` : "Unknown";
    const safeSize = escapeHtml(`${formatBytes(state.fileSizeBytes)} (${exactSize})`);
    const safeModified = escapeHtml(state.modifiedIso ?? "Unknown");
    const safeSha256 = escapeHtml(state.sha256 || "Unavailable");
    const safeMd5 = escapeHtml(state.md5 || "Unavailable");

    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: https:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${n}' https:`,
      `connect-src ${webview.cspSource} https:`,
      "worker-src blob: https:",
      `font-src ${webview.cspSource} data: https:`
    ].join("; ");

    const findingsHtml = state.findings.length
      ? `
      <section class="warn">
        <h3>Potential active content markers detected</h3>
        <p>
          ${
            state.blockActiveContent
              ? "Secure blocking is enabled, so rendering is blocked."
              : "Secure blocking is disabled, so rendering will continue."
          }
        </p>
        <ul>
          ${state.findings
            .map((f) => `<li><strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.description)}</li>`)
            .join("")}
        </ul>
      </section>
      `
      : "";

    const scanErrorHtml = state.scanError
      ? `
      <section class="warn">
        <h3>Scan warning</h3>
        <p>${escapeHtml(state.scanError)}</p>
      </section>
      `
      : "";

    const blockedHtml = `
      <section class="blocked">
        <h2>Rendering blocked</h2>
        <p>
          This PDF appears to contain active content and secure blocking is enabled
          (<code>idyicyanere.${escapeHtml(BLOCK_ACTIVE_CONTENT_SETTING)} = true</code>).
        </p>
        ${findingsHtml}
        ${scanErrorHtml}
      </section>
    `;

    const viewerHtml = `
      ${findingsHtml}
      ${scanErrorHtml}

      <section class="toolbar">
        <div class="toolbar-row">
          <button id="prevPageBtn" type="button" title="Previous page">Prev</button>
          <button id="nextPageBtn" type="button" title="Next page">Next</button>
          <span id="pageIndicator" class="muted">Page - / -</span>
          <input id="gotoInput" class="goto-input" type="number" min="1" step="1" placeholder="Page #" />
          <button id="gotoBtn" type="button">Go</button>
        </div>
        <div class="toolbar-row">
          <input id="searchInput" class="search-input" type="text" placeholder="Search text in document" />
          <button id="searchBtn" type="button">Find</button>
          <button id="searchPrevBtn" type="button" title="Previous match">Prev</button>
          <button id="searchNextBtn" type="button" title="Next match">Next</button>
          <span id="searchStatus" class="muted">No search yet.</span>
        </div>
        <p class="nav-help">Tip: use <strong>Go</strong> to jump pages and <strong>Find</strong> to cycle text matches.</p>
      </section>

      <div id="status" class="status">Loading inline PDF renderer...</div>
      <div id="pages" class="pages"></div>

      <details id="fallbackWrap" class="fallback">
        <summary>Fallback text view</summary>
        <div id="fallback">
          ${this.renderFallback(state)}
        </div>
      </details>

      <script type="module" nonce="${n}">
        const statusEl = document.getElementById("status");
        const pagesEl = document.getElementById("pages");
        const fallbackWrapEl = document.getElementById("fallbackWrap");
        const headerEl = document.querySelector(".header");
        const metaPageCountEl = document.getElementById("metaPageCount");
        const pageIndicatorEl = document.getElementById("pageIndicator");
        const searchStatusEl = document.getElementById("searchStatus");
        const gotoInputEl = document.getElementById("gotoInput");
        const gotoBtn = document.getElementById("gotoBtn");
        const prevPageBtn = document.getElementById("prevPageBtn");
        const nextPageBtn = document.getElementById("nextPageBtn");
        const searchInputEl = document.getElementById("searchInput");
        const searchBtn = document.getElementById("searchBtn");
        const searchPrevBtn = document.getElementById("searchPrevBtn");
        const searchNextBtn = document.getElementById("searchNextBtn");

        const pdfUrl = "${safePdfResource}";
        const workerSrc = "${safeWorker}";

        const pageSections = [];
        const pageTexts = [];
        let renderedPageCount = 0;
        let searchMatches = [];
        let searchCursor = -1;
        let scrollTimer;

        function setStatus(text, isError = false) {
          if (!statusEl) return;
          statusEl.textContent = text;
          statusEl.classList.toggle("error", !!isError);
        }

        function setSearchStatus(text, isError = false) {
          if (!searchStatusEl) return;
          searchStatusEl.textContent = text;
          searchStatusEl.classList.toggle("error", !!isError);
        }

        function showFallback(reason) {
          setStatus(reason, true);
          if (fallbackWrapEl) fallbackWrapEl.open = true;
        }

        function timeoutAfter(ms, label) {
          return new Promise((_, reject) => {
            setTimeout(() => reject(new Error(label)), ms);
          });
        }

        function clampPage(raw) {
          if (!renderedPageCount) return 1;
          const n = Math.floor(Number(raw) || 1);
          return Math.max(1, Math.min(renderedPageCount, n));
        }

        function nearestVisiblePage() {
          if (!pageSections.length) return 1;
          const anchor = (headerEl ? headerEl.getBoundingClientRect().bottom : 0) + 12;
          let page = 1;
          let bestScore = Number.POSITIVE_INFINITY;
          for (let i = 0; i < pageSections.length; i++) {
            const rect = pageSections[i].getBoundingClientRect();
            const score = Math.abs(rect.top - anchor);
            if (score < bestScore) {
              bestScore = score;
              page = i + 1;
            }
          }
          return page;
        }

        function updatePageIndicator(page) {
          if (!pageIndicatorEl) return;
          pageIndicatorEl.textContent = "Page " + page + " / " + renderedPageCount;
        }

        function updateActivePage(page) {
          for (let i = 0; i < pageSections.length; i++) {
            pageSections[i].classList.toggle("active-page", i + 1 === page);
          }
        }

        function updateSearchHighlights() {
          const currentMatchPage = searchCursor >= 0 ? searchMatches[searchCursor] : -1;
          for (let i = 0; i < pageSections.length; i++) {
            const page = i + 1;
            const section = pageSections[i];
            section.classList.toggle("search-hit", searchMatches.indexOf(page) >= 0);
            section.classList.toggle("search-current", page === currentMatchPage);
          }
        }

        function focusPage(page, smooth = true) {
          const target = clampPage(page);
          const section = pageSections[target - 1];
          if (!section) return;
          section.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
          if (gotoInputEl) gotoInputEl.value = String(target);
          updatePageIndicator(target);
          updateActivePage(target);
        }

        function extractSearchText(textContent) {
          if (!textContent || !Array.isArray(textContent.items)) return "";
          const chunks = [];
          for (const item of textContent.items) {
            if (item && typeof item.str === "string" && item.str.trim()) {
              chunks.push(item.str);
            }
          }
          return chunks.join(" ").replace(/\\s+/g, " ").trim().toLowerCase();
        }

        function findMatches(query) {
          const out = [];
          for (let i = 0; i < pageTexts.length; i++) {
            const pageText = pageTexts[i] || "";
            if (pageText.indexOf(query) >= 0) out.push(i + 1);
          }
          return out;
        }

        function moveSearch(delta) {
          if (!searchMatches.length) {
            setSearchStatus("No active matches. Run search first.", true);
            return;
          }
          searchCursor = (searchCursor + delta + searchMatches.length) % searchMatches.length;
          const page = searchMatches[searchCursor];
          setSearchStatus("Match " + (searchCursor + 1) + " of " + searchMatches.length + " (page " + page + ").");
          updateSearchHighlights();
          focusPage(page);
        }

        function runSearch(resetCursor = true) {
          if (!searchInputEl || typeof searchInputEl.value !== "string") return;
          const rawQuery = searchInputEl.value.trim();
          if (!rawQuery) {
            searchMatches = [];
            searchCursor = -1;
            updateSearchHighlights();
            setSearchStatus("Enter text to search.");
            return;
          }

          const query = rawQuery.toLowerCase();
          searchMatches = findMatches(query);

          if (!searchMatches.length) {
            searchCursor = -1;
            updateSearchHighlights();
            setSearchStatus('No matches for "' + rawQuery + '".', true);
            return;
          }

          if (resetCursor || searchCursor < 0 || searchCursor >= searchMatches.length) {
            searchCursor = 0;
          }

          const page = searchMatches[searchCursor];
          setSearchStatus("Match " + (searchCursor + 1) + " of " + searchMatches.length + " (page " + page + ").");
          updateSearchHighlights();
          focusPage(page);
        }

        gotoBtn?.addEventListener("click", () => focusPage(Number(gotoInputEl?.value || 1)));
        gotoInputEl?.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            focusPage(Number(gotoInputEl.value || 1));
          }
        });
        prevPageBtn?.addEventListener("click", () => focusPage(nearestVisiblePage() - 1));
        nextPageBtn?.addEventListener("click", () => focusPage(nearestVisiblePage() + 1));
        searchBtn?.addEventListener("click", () => runSearch(true));
        searchInputEl?.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            runSearch(true);
          }
        });
        searchPrevBtn?.addEventListener("click", () => moveSearch(-1));
        searchNextBtn?.addEventListener("click", () => moveSearch(1));

        window.addEventListener("scroll", () => {
          if (scrollTimer) clearTimeout(scrollTimer);
          scrollTimer = setTimeout(() => {
            const page = nearestVisiblePage();
            updatePageIndicator(page);
            updateActivePage(page);
          }, 70);
        });

        async function renderInlinePdf() {
          let pdfjsLib;
          try {
            pdfjsLib = await Promise.race([
              import("${safeMain}"),
              timeoutAfter(8000, "Timed out loading CDN PDF renderer.")
            ]);
          } catch (err) {
            showFallback("Could not load PDF renderer from CDN. Showing fallback text view.");
            return;
          }

          try {
            pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
          } catch {
            // continue; some builds may not expose GlobalWorkerOptions
          }

          try {
            const loadingTask = pdfjsLib.getDocument({
              url: pdfUrl,
              isEvalSupported: false,
              enableXfa: false,
              stopAtErrors: false
            });

            const pdf = await Promise.race([
              loadingTask.promise,
              timeoutAfter(15000, "Timed out rendering PDF document.")
            ]);
            const dpr = Math.max(1, window.devicePixelRatio || 1);
            renderedPageCount = pdf.numPages;
            if (metaPageCountEl) metaPageCountEl.textContent = String(pdf.numPages);
            if (gotoInputEl) {
              gotoInputEl.max = String(pdf.numPages);
              gotoInputEl.value = "1";
            }

            for (let i = 1; i <= pdf.numPages; i++) {
              const page = await pdf.getPage(i);
              const viewport = page.getViewport({ scale: 1.35 });

              const wrap = document.createElement("section");
              wrap.className = "rendered-page";
              wrap.setAttribute("data-page", String(i));

              const canvas = document.createElement("canvas");
              const ctx = canvas.getContext("2d", { alpha: false });
              if (!ctx) throw new Error("Canvas context unavailable");

              canvas.width = Math.floor(viewport.width * dpr);
              canvas.height = Math.floor(viewport.height * dpr);
              canvas.style.width = Math.floor(viewport.width) + "px";
              canvas.style.height = Math.floor(viewport.height) + "px";

              const renderContext = {
                canvasContext: ctx,
                viewport,
                transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
              };

              await page.render(renderContext).promise;

              try {
                const textContent = await page.getTextContent();
                pageTexts[i - 1] = extractSearchText(textContent);
              } catch {
                pageTexts[i - 1] = "";
              }

              wrap.appendChild(canvas);
              pagesEl?.appendChild(wrap);
              pageSections.push(wrap);
            }

            updatePageIndicator(1);
            updateActivePage(1);
            setStatus("Rendered " + pdf.numPages + " page(s).");
            if (fallbackWrapEl) fallbackWrapEl.open = false;
          } catch (err) {
            showFallback("Inline renderer failed to render this PDF. Showing fallback text view.");
          }
        }

        renderInlinePdf();
      </script>
    `;

    const bodyHtml = state.blocked ? blockedHtml : viewerHtml;

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp};" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root {
        --bg: #101317;
        --panel: #182029;
        --text: #d8e0ea;
        --muted: #9ca7b5;
        --warn: #ffd38a;
        --border: #2d3a46;
        --error: #ff9a9a;
      }

      * { box-sizing: border-box; }

      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: var(--vscode-font-family, sans-serif);
      }

      .wrap {
        width: 100%;
        min-height: 100%;
        display: flex;
        flex-direction: column;
      }

      .header {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 12px 10px;
        border-bottom: 1px solid var(--border);
        color: var(--muted);
        font-size: 12px;
        position: sticky;
        top: 0;
        background: rgba(16, 19, 23, 0.96);
        backdrop-filter: blur(6px);
        z-index: 5;
      }

      .header-top {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .title {
        color: var(--text);
        font-size: 14px;
        font-weight: 600;
        line-height: 1.25;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .badge {
        border: 1px solid var(--border);
        border-radius: 999px;
        background: #111821;
        color: var(--muted);
        padding: 2px 8px;
        font-size: 11px;
        white-space: nowrap;
      }

      .meta-grid {
        width: 100%;
        display: flex;
        flex-wrap: wrap;
        gap: 6px 8px;
      }

      .meta-item {
        border: 1px solid var(--border);
        border-radius: 999px;
        background: #111821;
        color: var(--text);
        padding: 2px 8px;
        white-space: nowrap;
      }

      .meta-item strong {
        color: var(--muted);
        font-weight: 600;
      }

      .hashes {
        border-top: 1px dashed var(--border);
        padding-top: 6px;
      }

      .hashes summary {
        cursor: pointer;
        color: var(--muted);
        user-select: none;
      }

      .hash-row {
        margin-top: 6px;
        display: grid;
        grid-template-columns: 70px minmax(0, 1fr);
        gap: 8px;
        align-items: start;
      }

      .hash-row strong {
        color: var(--muted);
        font-weight: 600;
      }

      .hash-row code {
        display: block;
        white-space: nowrap;
        overflow-x: auto;
      }

      .content {
        padding: 10px;
      }

      .toolbar,
      .warn,
      .blocked,
      .rendered-page,
      .fallback,
      .status {
        margin: 0 0 10px;
        padding: 10px;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
      }

      .warn,
      .blocked {
        border-left: 4px solid var(--warn);
      }

      .status.error {
        border-left: 4px solid var(--error);
        color: var(--error);
      }

      .warn h3,
      .blocked h2 {
        margin: 0 0 8px;
      }

      .toolbar {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .toolbar-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }

      .search-input {
        flex: 1;
        min-width: 200px;
      }

      .goto-input {
        width: 92px;
      }

      .muted {
        color: var(--muted);
        font-size: 11px;
      }

      button,
      input {
        border: 1px solid var(--border);
        border-radius: 6px;
        background: #111821;
        color: var(--text);
        padding: 5px 9px;
        font-size: 12px;
        height: 30px;
      }

      button {
        cursor: pointer;
      }

      button:hover {
        border-color: #46627b;
      }

      #searchStatus.error {
        color: var(--error);
      }

      .nav-help {
        margin: 0;
        color: var(--muted);
        font-size: 11px;
      }

      .rendered-page {
        padding: 8px;
        scroll-margin-top: 180px;
      }

      .rendered-page.active-page {
        border-color: #5ca7ff;
      }

      .rendered-page.search-hit {
        border-left: 4px solid #95d884;
      }

      .rendered-page.search-current {
        box-shadow: 0 0 0 1px #95d884 inset;
      }

      .pages {
        display: flex;
        flex-direction: column;
        gap: 10px;
        align-items: center;
      }

      .pages canvas {
        display: block;
        background: #fff;
        border: 1px solid #d8d8d8;
        border-radius: 4px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
        max-width: 100%;
        height: auto;
      }

      .fallback summary {
        cursor: pointer;
      }

      .fallback-page {
        margin: 10px 0;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #0e141b;
      }

      .fallback-page h3 {
        margin: 0 0 8px;
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        line-height: 1.5;
      }

      ul {
        margin: 6px 0 0 20px;
      }

      code {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        background: rgba(255, 255, 255, 0.08);
        padding: 1px 4px;
        border-radius: 4px;
      }

      @media (max-width: 720px) {
        .header-top {
          flex-wrap: wrap;
        }

        .title {
          white-space: normal;
        }

        .toolbar-row {
          align-items: stretch;
        }

        .search-input {
          min-width: 140px;
        }

        .hash-row {
          grid-template-columns: 1fr;
          gap: 4px;
        }
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <header class="header">
        <div class="header-top">
          <span class="title">${title}</span>
          <span class="badge">Secure blocking: ${state.blockActiveContent ? "ON" : "OFF"}</span>
        </div>
        <div class="meta-grid">
          <span class="meta-item"><strong>Pages:</strong> <span id="metaPageCount">-</span></span>
          <span class="meta-item"><strong>Size:</strong> ${safeSize}</span>
          <span class="meta-item"><strong>Modified:</strong> ${safeModified}</span>
        </div>
        <details class="hashes">
          <summary>Checksums</summary>
          <div class="hash-row"><strong>SHA-256:</strong> <code>${safeSha256}</code></div>
          <div class="hash-row"><strong>MD5:</strong> <code>${safeMd5}</code></div>
        </details>
      </header>
      <section class="content">
        ${bodyHtml}
      </section>
    </main>
  </body>
</html>`;
  }
}
