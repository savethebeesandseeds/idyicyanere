import * as vscode from "vscode";

export type LogLevel = "debug" | "info" | "warn" | "error";

const rank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

let channel: vscode.OutputChannel | undefined;
let currentLevel: LogLevel = "info";

export function isLogLevel(v: unknown): v is LogLevel {
  return v === "debug" || v === "info" || v === "warn" || v === "error";
}

function getChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("idyicyanere");
  return channel;
}

function ts(): string {
  return new Date().toISOString();
}

function fmt(meta?: unknown): string {
  if (meta === undefined) return "";
  try {
    if (typeof meta === "string") return ` ${meta}`;
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return " [meta:unserializable]";
  }
}

function write(level: LogLevel, msg: string, meta?: unknown) {
  if (rank[level] < rank[currentLevel]) return;

  const line = `[${ts()}] [${level.toUpperCase()}] ${msg}${fmt(meta)}`;
  getChannel().appendLine(line);

  // Also goes to Debug Console (useful during F5)
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  setLevel(level: LogLevel) {
    currentLevel = level;

    // Log at the *new* level so it always shows (even when setting warn/error).
    write(level, `log level set -> ${level}`);
  },

  show(preserveFocus = true) {
    getChannel().show(preserveFocus);
  },

  debug(msg: string, meta?: unknown) {
    write("debug", msg, meta);
  },
  info(msg: string, meta?: unknown) {
    write("info", msg, meta);
  },
  warn(msg: string, meta?: unknown) {
    write("warn", msg, meta);
  },
  error(msg: string, meta?: unknown) {
    write("error", msg, meta);
  },

  // Convenience wrapper for try/catch
  caught(where: string, err: unknown) {
    const e = err as any;
    write("error", `${where} threw`, {
      message: e?.message ?? String(err),
      stack: e?.stack
    });
  },

  dispose() {
    channel?.dispose();
    channel = undefined;
  }
};

export function registerLogger(context: vscode.ExtensionContext) {
  context.subscriptions.push({ dispose: () => log.dispose() });
}
