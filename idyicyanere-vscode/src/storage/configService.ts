import * as vscode from "vscode";
import { StoragePaths } from "./paths";
import { LogLevel, isLogLevel, log } from "../logging/logger";

/**
 * ───────────────────────────────────────────────────────────────────────────────
 * IMPORTANT: NO BACKWARD COMPATIBILITY FOR config.json
 *
 * This project intentionally does NOT maintain backward compatibility for config.json.
 * Older configuration files are worse than a hard reset because they silently misconfigure
 * behavior and waste debugging time.
 *
 * Policy:
 *  - config.json MUST include `schemaVersion` matching CONFIG_SCHEMA_VERSION.
 *  - If missing or mismatched => the extension will:
 *      1) write a backup copy next to the config file
 *      2) overwrite config.json with fresh defaults for the current schemaVersion
 *
 * Additionally:
 *  - Writes are ATOMIC (temp + rename) to avoid "Unexpected end of JSON input".
 *  - Canonicalization is avoided while the file is open to prevent editor/save conflicts.
 *  - Calls are serialized via a simple lock to avoid concurrent reads/writes.
 * ───────────────────────────────────────────────────────────────────────────────
 */

export const CONFIG_SCHEMA_VERSION = 6 as const;

export type RagMetric = "cosine" | "l2";

export type ChunkingMethod = "chars";
export interface ChunkingRule {
  method: ChunkingMethod;
  chunkChars: number;
}

export interface ContextDumpConfig {
  dirName: string;
  latestFileName: string;
  keepBackups: number;
  includeHidden: boolean;
  noFences: boolean;
  listOnly: boolean;
  maxFileBytes: number; // 0 = unlimited
  maxTotalBytes: number; // 0 = unlimited
  openAfterDump: boolean;
}

/** Edit planner config (strict schema, current version only). */
export interface EditPlannerConfig {
  trace: {
    enabled: boolean;
  };

  parallel: {
    unitChanges: number;
    files: number;
  };

  rag: {
    enabled: boolean;
    k: number;
    metric: RagMetric;
  };

  segmentation: {
    newlineSnap: boolean;
    newlineSnapWindow: number;
    newlinePreferForward: boolean;
    minFragmentChars: number;
    maxFragmentChars: number;
    contextChars: number;
  };

  targeting: {
    useRagHits: boolean;
    maxCandidateFiles: number;
    padBeforeChars: number;
    padAfterChars: number;
    mergeGapChars: number;
    maxWindowsPerUnit: number;
  };

  attempts: {
    maxRounds: number;
    validateModel: "light" | "heavy" | "superHeavy";
  };

  guards: {
    discardWhitespaceOnlyChanges: boolean;
    preserveLineEndings: boolean;
    maxPatchCoverageWarn: number; // 0..1
    maxPatchCoverageError: number; // 0..1
  };

  validation: {
    final: "light" | "heavy" | "superHeavy";
  };
}

export interface FilesViewConfig {
  /**
   * Extra excludes applied by the Files View (globs).
   * These are merged with VS Code excludes when enabled.
   */
  excludeGlobs: string[];

  /**
   * If true, also respect VS Code settings:
   *  - files.exclude
   *  - search.exclude
   */
  useVscodeExcludes: boolean;
}

export interface AppConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;

  logging: {
    level: LogLevel;
  };

  openai: {
    embeddingModel: string;
    modelLight: string;
    modelHeavy: string;
    modelSuperHeavy: string;
  };

  rag: {
    k: number;
    maxChars: number;
    metric: RagMetric;
  };

  indexing: {
    chunkChars: number;
    maxFileBytes: number;
    excludeGlobs: string[];
    chunking: {
      default: ChunkingRule;
      byExtension: Record<string, ChunkingRule>;
    };
  };

  filesView: FilesViewConfig;

  contextDump: ContextDumpConfig;

  editPlanner: EditPlannerConfig;
}

const DEFAULT_EDIT_PLANNER: EditPlannerConfig = {
  trace: { enabled: true },

  parallel: {
    unitChanges: 6,
    files: 4
  },

  rag: {
    enabled: true,
    k: 12,
    metric: "cosine"
  },

  segmentation: {
    newlineSnap: true,
    newlineSnapWindow: 800,
    newlinePreferForward: true,
    minFragmentChars: 900,
    maxFragmentChars: 12000,
    contextChars: 900
  },

  targeting: {
    useRagHits: true,
    maxCandidateFiles: 60,
    padBeforeChars: 600,
    padAfterChars: 300,
    mergeGapChars: 200,
    maxWindowsPerUnit: 1
  },

  attempts: {
    maxRounds: 3,
    validateModel: "light"
  },

  guards: {
    discardWhitespaceOnlyChanges: true,
    preserveLineEndings: true,
    maxPatchCoverageWarn: 0.75,
    maxPatchCoverageError: 1.0
  },

  validation: {
    final: "heavy"
  }
};

const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,

  logging: { level: "debug" },

  openai: {
    embeddingModel: "text-embedding-3-small",
    modelLight: "gpt-5.1-codex-max",
    modelHeavy: "gpt-5.1-codex-max",
    modelSuperHeavy: "gpt-5.2"
  },

  rag: { k: 6, maxChars: 12000, metric: "cosine" },

  indexing: {
    chunkChars: 6000,
    maxFileBytes: 500_000,
    excludeGlobs: [],
    chunking: {
      default: { method: "chars", chunkChars: 6000 },
      byExtension: {}
    }
  },

  contextDump: {
    dirName: "context_dumps",
    latestFileName: "indexed_context_dump.txt",
    keepBackups: 5,
    includeHidden: false,
    noFences: false,
    listOnly: false,
    maxFileBytes: 0,
    maxTotalBytes: 0,
    openAfterDump: true
  },

  filesView: {
    useVscodeExcludes: true,
    excludeGlobs: [
      "**/.git/**",
      "**/.hg/**",
      "**/.svn/**",
      "**/.idea/**",
      "**/.vscode/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/out/**",
      "**/.next/**",
      "**/.nuxt/**",
      "**/.cache/**",
      "**/.turbo/**",
      "**/.vercel/**",
      "**/coverage/**",
      "**/target/**",
      "**/.venv/**",
      "**/venv/**",
      "**/__pycache__/**",
      "**/.DS_Store",
      "**/Thumbs.db"
    ]
  },

  editPlanner: DEFAULT_EDIT_PLANNER
};

function isRecord(x: any): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function toStringArray(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeName(v: any, fallback: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return fallback;
  if (s.includes("/") || s.includes("\\") || s.includes("..")) return fallback;
  return s;
}

function safeString(v: any, fallback: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : fallback;
}

function clampInt(n: any, fallback: number, min: number, max: number): number {
  const v = Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : fallback;
  return Math.max(min, Math.min(max, v));
}

function clampNum(n: any, fallback: number, min: number, max: number): number {
  const v = Number.isFinite(Number(n)) ? Number(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

function asBool(v: any, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes" || t === "on") return true;
    if (t === "false" || t === "0" || t === "no" || t === "off") return false;
  }
  if (typeof v === "number") return v !== 0;
  return fallback;
}

function parentDir(u: vscode.Uri): vscode.Uri {
  const parts = u.path.split("/");
  parts.pop();
  const dirPath = parts.join("/") || "/";
  return u.with({ path: dirPath });
}

async function ensureDirForFile(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(parentDir(uri));
  } catch {
    // ignore; createDirectory is idempotent-ish and can race across processes
  }
}

function replaceBasename(u: vscode.Uri, newName: string): vscode.Uri {
  const parts = u.path.split("/");
  parts[parts.length - 1] = newName;
  return u.with({ path: parts.join("/") });
}

/** Small content fingerprint to dedupe repeated backups. */
function fnv1a32(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export class ConfigService {
  public data: AppConfig = DEFAULT_CONFIG;

  // serialize reads/writes to avoid overlapping load() calls
  private loadLock: Promise<void> = Promise.resolve();

  // watcher suppression helper (optional usage in extension watcher)
  private lastWriteAtMs = 0;

  // serialize atomic writes per-target across *all* instances
  private static writeLocks = new Map<string, Promise<void>>();

  // loop guards / throttled UX warnings
  private lastExternalWriterWarnAtMs = 0;
  private lastDirtyMismatchWarnAtMs = 0;

  // prevent infinite backup spam if the same incompatible content keeps reappearing
  private lastBackupFingerprintByReason = new Map<string, string>();

  constructor(private readonly paths: StoragePaths) {}

  /** True if we wrote config.json very recently (useful for watcher suppression). */
  recentlyWrote(withinMs = 750): boolean {
    return Date.now() - this.lastWriteAtMs <= withinMs;
  }

  private findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    const key = uri.toString();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  }

  async ensure(): Promise<void> {
    await this.withLoadLock(async () => {
      log.debug("ConfigService.ensure()", { configPath: this.paths.configUri.toString() });

      // No migration: legacy workspace config is ignored by design.
      if (this.paths.legacyWorkspaceConfigUri && (await exists(this.paths.legacyWorkspaceConfigUri))) {
        log.warn("Legacy workspace config.json exists but is ignored (no back-compat policy).", {
          legacy: this.paths.legacyWorkspaceConfigUri.toString()
        });
      }

      if (!(await exists(this.paths.configUri))) {
        log.info("config.json missing; writing defaults (strict schema)", { configPath: this.paths.configUri.toString() });
        await this.writeJsonAtomic(this.paths.configUri, DEFAULT_CONFIG);
      }

      await this.loadInner();
    });
  }

  async load(): Promise<void> {
    await this.withLoadLock(async () => this.loadInner());
  }

  async save(): Promise<void> {
    await this.withLoadLock(async () => {
      log.debug("ConfigService.save()", { configPath: this.paths.configUri.toString() });
      await this.writeJsonAtomic(this.paths.configUri, this.data);
    });
  }

  async openInEditor(): Promise<void> {
    await this.ensure();
    const doc = await vscode.workspace.openTextDocument(this.paths.configUri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async withLoadLock(fn: () => Promise<void>): Promise<void> {
    const next = this.loadLock.then(fn, fn);
    this.loadLock = next.catch(() => {});
    await next;
  }

  private async loadInner(): Promise<void> {
    const uri = this.paths.configUri;

    let bytes: Uint8Array;
    let parsed: any;

    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      const isMissing = msg.includes("ENOENT");

      if (isMissing) {
        log.info("ConfigService.load: config.json missing; writing defaults", { configPath: uri.toString() });
      } else {
        log.caught("ConfigService.load read", err);
      }

      this.data = DEFAULT_CONFIG;
      await this.writeJsonAtomic(uri, DEFAULT_CONFIG);
      if (!isMissing) {
        vscode.window.showWarningMessage("idyicyanere: config.json could not be read; reset to defaults.");
      }
      return;
    }

    const text = new TextDecoder("utf-8").decode(bytes);

    try {
      parsed = JSON.parse(text);
    } catch (err) {
      log.caught("ConfigService.load parse", err);
      await this.backupAndReset(uri, text, "invalid_json");
      return;
    }

    const sv = isRecord(parsed) ? parsed.schemaVersion : undefined;

    // If file is from a *newer* schema, never downgrade / overwrite.
    if (typeof sv === "number" && sv > CONFIG_SCHEMA_VERSION) {
      log.warn("config.json schema is newer than this extension; refusing to overwrite.", {
        found: sv,
        expected: CONFIG_SCHEMA_VERSION,
        config: uri.toString()
      });

      // keep running with defaults in-memory
      this.data = DEFAULT_CONFIG;

      const now = Date.now();
      if (now - this.lastExternalWriterWarnAtMs > 10_000) {
        this.lastExternalWriterWarnAtMs = now;
        vscode.window.showWarningMessage(
          `idyicyanere: config.json schemaVersion=${sv} is newer than this extension (expected ${CONFIG_SCHEMA_VERSION}). ` +
            `Update the extension or delete the config to regenerate defaults.`
        );
      }
      return;
    }

    if (sv !== CONFIG_SCHEMA_VERSION) {
      // If we just wrote config.json but it's already mismatched again, another writer is fighting us.
      if (this.recentlyWrote(2000)) {
        log.error("config.json schema mismatch immediately after we wrote it. Another process/extension host is overwriting it.", {
          found: sv ?? "missing",
          expected: CONFIG_SCHEMA_VERSION,
          config: uri.toString()
        });

        this.data = DEFAULT_CONFIG;

        const now = Date.now();
        if (now - this.lastExternalWriterWarnAtMs > 10_000) {
          this.lastExternalWriterWarnAtMs = now;
          vscode.window.showErrorMessage(
            "idyicyanere: config.json keeps reverting. This usually means another VS Code window/extension host (often an older build) " +
              "is writing the config at the same time. Close other windows or uninstall the older version, then delete the globalStorage config."
          );
        }
        return;
      }

      await this.backupAndReset(uri, text, `schema_mismatch_${String(sv ?? "missing")}`);
      return;
    }

    const sanitized = this.sanitizeWithinSchema(parsed);
    this.data = sanitized;

    // Canonicalization is intentionally avoided here (especially while file is open)
    // to prevent save/reload conflicts and surprising formatting rewrites.

    log.debug("config.json loaded (strict schema)", {
      schemaVersion: sanitized.schemaVersion,
      loggingLevel: sanitized.logging.level,
      openai: {
        embeddingModel: sanitized.openai.embeddingModel,
        modelLight: sanitized.openai.modelLight,
        modelHeavy: sanitized.openai.modelHeavy,
        modelSuperHeavy: sanitized.openai.modelSuperHeavy
      }
    });
  }

  private async backupAndReset(uri: vscode.Uri, oldText: string, reason: string): Promise<void> {
    // If user is editing the config (dirty), do NOT back up and overwrite in a loop.
    const openDoc = this.findOpenDocument(uri);
    if (openDoc?.isDirty) {
      log.warn("config.json incompatible but open+dirty; refusing to backup/reset to avoid an infinite loop.", {
        reason,
        config: uri.toString()
      });

      this.data = DEFAULT_CONFIG;

      const now = Date.now();
      if (now - this.lastDirtyMismatchWarnAtMs > 10_000) {
        this.lastDirtyMismatchWarnAtMs = now;
        vscode.window.showWarningMessage(
          "idyicyanere: config.json is incompatible but currently open with unsaved changes. " +
            "Close/discard your edits (or fix schemaVersion) so the extension can reset it."
        );
      }
      return;
    }

    try {
      const fingerprint = fnv1a32(oldText);
      const fpKey = `${uri.toString()}::${reason}`;
      const prev = this.lastBackupFingerprintByReason.get(fpKey);
      const shouldWriteBackup = prev !== fingerprint;
      if (shouldWriteBackup) this.lastBackupFingerprintByReason.set(fpKey, fingerprint);

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backupName = `config.backup.${reason}.${ts}.json`;
      const backupUri = replaceBasename(uri, backupName);

      if (shouldWriteBackup) {
        await vscode.workspace.fs.writeFile(backupUri, new TextEncoder().encode(oldText));
      } else {
        log.warn("Skipping duplicate config backup (same content already backed up for this reason).", {
          reason,
          config: uri.toString()
        });
      }

      log.warn("config.json incompatible; backed up + reset to defaults", {
        reason,
        backup: shouldWriteBackup ? backupUri.toString() : "<skipped-duplicate>",
        config: uri.toString()
      });

      await this.writeJsonAtomic(uri, DEFAULT_CONFIG);
      this.data = DEFAULT_CONFIG;

      vscode.window.showWarningMessage(
        `idyicyanere: config.json was incompatible (${reason}) and was reset to defaults.` +
          (shouldWriteBackup ? " A backup was written next to it." : " (Backup skipped: duplicate content.)")
      );
    } catch (err) {
      log.caught("ConfigService.backupAndReset", err);
      try {
        await this.writeJsonAtomic(uri, DEFAULT_CONFIG);
      } catch (e2) {
        log.caught("ConfigService.backupAndReset secondary write", e2);
      }
      this.data = DEFAULT_CONFIG;
      vscode.window.showWarningMessage("idyicyanere: config.json was incompatible and was reset to defaults.");
    }
  }

  private sanitizeWithinSchema(raw: any): AppConfig {
    // Start from defaults then fill allowed fields (unknown keys are ignored intentionally).
    const out: AppConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    out.schemaVersion = CONFIG_SCHEMA_VERSION;

    // logging
    const lvl = (raw?.logging as any)?.level;
    out.logging.level = isLogLevel(lvl) ? lvl : DEFAULT_CONFIG.logging.level;

    // openai
    out.openai.embeddingModel = safeString(raw?.openai?.embeddingModel, DEFAULT_CONFIG.openai.embeddingModel);
    out.openai.modelLight = safeString(raw?.openai?.modelLight, DEFAULT_CONFIG.openai.modelLight);
    out.openai.modelHeavy = safeString(raw?.openai?.modelHeavy, DEFAULT_CONFIG.openai.modelHeavy);
    out.openai.modelSuperHeavy = safeString(raw?.openai?.modelSuperHeavy, DEFAULT_CONFIG.openai.modelSuperHeavy);

    // rag
    out.rag.k = clampInt(raw?.rag?.k, DEFAULT_CONFIG.rag.k, 1, 50);
    out.rag.maxChars = clampInt(raw?.rag?.maxChars, DEFAULT_CONFIG.rag.maxChars, 1000, 200000);
    out.rag.metric = raw?.rag?.metric === "cosine" || raw?.rag?.metric === "l2" ? raw.rag.metric : DEFAULT_CONFIG.rag.metric;

    // indexing
    out.indexing.chunkChars = clampInt(raw?.indexing?.chunkChars, DEFAULT_CONFIG.indexing.chunkChars, 500, 60000);
    out.indexing.maxFileBytes = clampInt(raw?.indexing?.maxFileBytes, DEFAULT_CONFIG.indexing.maxFileBytes, 10_000, 50_000_000);
    out.indexing.excludeGlobs = toStringArray(raw?.indexing?.excludeGlobs);

    // chunking.default
    out.indexing.chunking.default.method = "chars";
    out.indexing.chunking.default.chunkChars = clampInt(
      raw?.indexing?.chunking?.default?.chunkChars,
      out.indexing.chunkChars,
      500,
      60000
    );

    // chunking.byExtension
    out.indexing.chunking.byExtension = {};
    const byExt = raw?.indexing?.chunking?.byExtension;
    if (byExt && typeof byExt === "object") {
      for (const [k, v] of Object.entries(byExt)) {
        const ext = (String(k).startsWith(".") ? String(k) : `.${String(k)}`).toLowerCase();
        const chunkChars = clampInt((v as any)?.chunkChars, out.indexing.chunking.default.chunkChars, 500, 60000);
        out.indexing.chunking.byExtension[ext] = { method: "chars", chunkChars };
      }
    }

    // filesView
    out.filesView.useVscodeExcludes = asBool(raw?.filesView?.useVscodeExcludes, DEFAULT_CONFIG.filesView.useVscodeExcludes);
    out.filesView.excludeGlobs = toStringArray(raw?.filesView?.excludeGlobs);
    if (!out.filesView.excludeGlobs.length) {
      // keep defaults if user sets junk / empty; v1 stability
      out.filesView.excludeGlobs = DEFAULT_CONFIG.filesView.excludeGlobs.slice();
    }

    // contextDump
    out.contextDump.dirName = safeName(raw?.contextDump?.dirName, DEFAULT_CONFIG.contextDump.dirName);
    out.contextDump.latestFileName = safeName(raw?.contextDump?.latestFileName, DEFAULT_CONFIG.contextDump.latestFileName);
    out.contextDump.keepBackups = clampInt(raw?.contextDump?.keepBackups, DEFAULT_CONFIG.contextDump.keepBackups, 0, 50);
    out.contextDump.includeHidden = !!raw?.contextDump?.includeHidden;
    out.contextDump.noFences = !!raw?.contextDump?.noFences;
    out.contextDump.listOnly = !!raw?.contextDump?.listOnly;
    out.contextDump.maxFileBytes = clampInt(raw?.contextDump?.maxFileBytes, DEFAULT_CONFIG.contextDump.maxFileBytes, 0, 50_000_000);
    out.contextDump.maxTotalBytes = clampInt(raw?.contextDump?.maxTotalBytes, DEFAULT_CONFIG.contextDump.maxTotalBytes, 0, 500_000_000);
    out.contextDump.openAfterDump = raw?.contextDump?.openAfterDump !== false;

    // editPlanner
    const ep = raw?.editPlanner ?? {};

    // trace
    out.editPlanner.trace.enabled = asBool(ep?.trace?.enabled, DEFAULT_EDIT_PLANNER.trace.enabled);

    // parallel
    out.editPlanner.parallel.unitChanges = clampInt(ep?.parallel?.unitChanges, DEFAULT_EDIT_PLANNER.parallel.unitChanges, 1, 64);
    out.editPlanner.parallel.files = clampInt(ep?.parallel?.files, DEFAULT_EDIT_PLANNER.parallel.files, 1, 64);

    // rag
    out.editPlanner.rag.enabled = asBool(ep?.rag?.enabled, DEFAULT_EDIT_PLANNER.rag.enabled);
    out.editPlanner.rag.k = clampInt(ep?.rag?.k, DEFAULT_EDIT_PLANNER.rag.k, 1, 200);
    out.editPlanner.rag.metric =
      ep?.rag?.metric === "cosine" || ep?.rag?.metric === "l2" ? ep.rag.metric : DEFAULT_EDIT_PLANNER.rag.metric;

    // segmentation
    out.editPlanner.segmentation.newlineSnap = asBool(ep?.segmentation?.newlineSnap, DEFAULT_EDIT_PLANNER.segmentation.newlineSnap);
    out.editPlanner.segmentation.newlineSnapWindow = clampInt(ep?.segmentation?.newlineSnapWindow, DEFAULT_EDIT_PLANNER.segmentation.newlineSnapWindow, 0, 20_000);
    out.editPlanner.segmentation.newlinePreferForward = asBool(ep?.segmentation?.newlinePreferForward, DEFAULT_EDIT_PLANNER.segmentation.newlinePreferForward);
    out.editPlanner.segmentation.minFragmentChars = clampInt(ep?.segmentation?.minFragmentChars, DEFAULT_EDIT_PLANNER.segmentation.minFragmentChars, 100, 200_000);
    out.editPlanner.segmentation.maxFragmentChars = clampInt(
      ep?.segmentation?.maxFragmentChars,
      DEFAULT_EDIT_PLANNER.segmentation.maxFragmentChars,
      out.editPlanner.segmentation.minFragmentChars,
      500_000
    );
    out.editPlanner.segmentation.contextChars = clampInt(ep?.segmentation?.contextChars, DEFAULT_EDIT_PLANNER.segmentation.contextChars, 0, 200_000);

    // targeting
    out.editPlanner.targeting.useRagHits = asBool(ep?.targeting?.useRagHits, DEFAULT_EDIT_PLANNER.targeting.useRagHits);
    out.editPlanner.targeting.maxCandidateFiles = clampInt(ep?.targeting?.maxCandidateFiles, DEFAULT_EDIT_PLANNER.targeting.maxCandidateFiles, 1, 5000);
    out.editPlanner.targeting.padBeforeChars = clampInt(ep?.targeting?.padBeforeChars, DEFAULT_EDIT_PLANNER.targeting.padBeforeChars, 0, 500_000);
    out.editPlanner.targeting.padAfterChars = clampInt(ep?.targeting?.padAfterChars, DEFAULT_EDIT_PLANNER.targeting.padAfterChars, 0, 500_000);
    out.editPlanner.targeting.mergeGapChars = clampInt(ep?.targeting?.mergeGapChars, DEFAULT_EDIT_PLANNER.targeting.mergeGapChars, 0, 500_000);
    out.editPlanner.targeting.maxWindowsPerUnit = clampInt(ep?.targeting?.maxWindowsPerUnit, DEFAULT_EDIT_PLANNER.targeting.maxWindowsPerUnit, 1, 50);

    // attempts
    out.editPlanner.attempts.maxRounds = clampInt(ep?.attempts?.maxRounds, DEFAULT_EDIT_PLANNER.attempts.maxRounds, 1, 12);
    {
      const vmRaw = typeof ep?.attempts?.validateModel === "string" ? ep.attempts.validateModel.trim() : "";
      out.editPlanner.attempts.validateModel = vmRaw === "heavy" ? "heavy" : vmRaw === "superHeavy" ? "superHeavy" : "light";
    }

    // guards
    out.editPlanner.guards.discardWhitespaceOnlyChanges = asBool(ep?.guards?.discardWhitespaceOnlyChanges, DEFAULT_EDIT_PLANNER.guards.discardWhitespaceOnlyChanges);
    out.editPlanner.guards.preserveLineEndings = asBool(ep?.guards?.preserveLineEndings, DEFAULT_EDIT_PLANNER.guards.preserveLineEndings);
    out.editPlanner.guards.maxPatchCoverageWarn = clampNum(ep?.guards?.maxPatchCoverageWarn, DEFAULT_EDIT_PLANNER.guards.maxPatchCoverageWarn, 0, 1);
    out.editPlanner.guards.maxPatchCoverageError = clampNum(ep?.guards?.maxPatchCoverageError, DEFAULT_EDIT_PLANNER.guards.maxPatchCoverageError, 0, 1);
    if (out.editPlanner.guards.maxPatchCoverageError < out.editPlanner.guards.maxPatchCoverageWarn) {
      out.editPlanner.guards.maxPatchCoverageError = Math.min(1, out.editPlanner.guards.maxPatchCoverageWarn + 0.15);
    }

    // validation
    {
      const vRaw = typeof ep?.validation?.final === "string" ? ep.validation.final.trim() : "";
      out.editPlanner.validation.final = vRaw === "light" ? "light" : vRaw === "superHeavy" ? "superHeavy" : "heavy";
    }

    return out;
  }

  private async writeJsonAtomic(uri: vscode.Uri, obj: unknown): Promise<void> {
    const text = JSON.stringify(obj, null, 2) + "\n";
    await this.writeTextAtomic(uri, text);
  }

  private async withWriteLock(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = ConfigService.writeLocks.get(key) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const cur = prev.then(() => gate);
    ConfigService.writeLocks.set(key, cur);

    await prev;
    try {
      await fn();
    } finally {
      release();
      if (ConfigService.writeLocks.get(key) === cur) {
        ConfigService.writeLocks.delete(key);
      }
    }
  }

  private makeTmpUri(uri: vscode.Uri): vscode.Uri {
    const stamp = Date.now().toString(16);
    const rand = Math.random().toString(16).slice(2);
    // same directory as target => rename stays atomic
    return uri.with({ path: `${uri.path}.tmp.${stamp}.${rand}` });
  }

  private async writeTextAtomic(uri: vscode.Uri, text: string): Promise<void> {
    const key = uri.toString(); // stable lock key

    await this.withWriteLock(key, async () => {
      // If config.json is open in an editor, avoid temp+rename replacement.
      // Also avoid doc.save() (it can return false under conflict); write directly to fs instead.
      const openDoc = this.findOpenDocument(uri);
      if (openDoc && !openDoc.isUntitled) {
        if (openDoc.isDirty) {
          log.warn("Skipped writing config.json because it is open and has unsaved changes.", {
            configPath: uri.toString()
          });
          return;
        }

        await ensureDirForFile(uri);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
        this.lastWriteAtMs = Date.now();
        return;
      }

      const enc = new TextEncoder();
      const tmp = this.makeTmpUri(uri);

      // ✅ ensure parent directory exists (globalStorage/.../waajacu.idyicyanere/)
      await ensureDirForFile(uri);

      try {
        await vscode.workspace.fs.writeFile(tmp, enc.encode(text));
        await vscode.workspace.fs.rename(tmp, uri, { overwrite: true });
        this.lastWriteAtMs = Date.now();
      } catch (err) {
        try {
          await vscode.workspace.fs.delete(tmp, { useTrash: false });
        } catch {}
        throw err;
      }
    });
  }
}
