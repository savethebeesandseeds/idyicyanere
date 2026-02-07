import * as vscode from "vscode";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as crypto from "crypto";
import { once } from "events";

import { log } from "../logging/logger";
import { countNewlines, langForRel, DumpStats, DumpWriteOptions, DumpWriterItem } from "./contextDumpUtils";

async function sha256HexFile(fsPath: string): Promise<string> {
  return new Promise((resolve) => {
    const h = crypto.createHash("sha256");
    const rs = fs.createReadStream(fsPath);
    rs.on("data", (chunk) => h.update(chunk));
    rs.on("error", () => resolve("n/a"));
    rs.on("end", () => resolve(h.digest("hex")));
  });
}

async function hasNullByte(fsPath: string, limit = 2048): Promise<boolean> {
  try {
    const fh = await fsp.open(fsPath, "r");
    try {
      const buf = Buffer.alloc(limit);
      const { bytesRead } = await fh.read(buf, 0, limit, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } finally {
      await fh.close();
    }
  } catch {
    // If we can't probe safely, treat as non-text to avoid dumping garbage.
    return true;
  }
}

async function readUpTo(fsPath: string, maxBytes: number): Promise<Buffer> {
  const fh = await fsp.open(fsPath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

type WriterArgs = {
  outputFsPath: string;
  headerLines: string[];
  items: DumpWriterItem[];
  stats: DumpStats;
  opts: DumpWriteOptions;
  report?: (msg: string) => void;
  token?: vscode.CancellationToken;
};

export async function writeContextDump(args: WriterArgs): Promise<{ cancelled: boolean }> {
  const { outputFsPath, headerLines, items, stats, opts, report, token } = args;

  const ws = fs.createWriteStream(outputFsPath, { encoding: "utf8" });

  const write = async (s: string) => {
    if (!ws.write(s, "utf8")) await once(ws, "drain");
  };
  const writeln = async (s: string) => write(s + "\n");
  const blank = async () => write("\n");

  let cancelled = false;

  try {
    // Header
    for (const ln of headerLines) await writeln(ln);
    await blank();

    for (let i = 0; i < items.length; i++) {
      if (token?.isCancellationRequested) {
        cancelled = true;
        await writeln("### Cancelled by user.");
        break;
      }

      const it = items[i];
      report?.(`Dumping ${i + 1}/${items.length}: ${it.rel}`);

      // max-total enforcement (content bytes)
      if (opts.maxTotalBytes > 0 && stats.totalBytesWritten >= opts.maxTotalBytes) {
        stats.stoppedByMaxTotal = true;
        await writeln(`### Reached --max-total=${opts.maxTotalBytes} bytes. Stopping.`);
        break;
      }

      // stat
      let st: vscode.FileStat;
      try {
        st = await vscode.workspace.fs.stat(it.uri);
      } catch {
        stats.skippedMissing++;
        await writeln(`===== FILE (skipped missing): ${it.rel} (hidden=${it.hidden}) =====`);
        await blank();
        continue;
      }

      const size = st.size;
      const stale = !!it.stale;
      const indexed = !!it.indexed;

      // detect binary
      const nullByte = await hasNullByte(it.uri.fsPath, 2048);
      if (nullByte) {
        stats.skippedBinary++;
        const sha = await sha256HexFile(it.uri.fsPath);
        await writeln(
          `===== FILE (skipped binary): ${it.rel} (bytes=${size}, sha256=${sha}, hidden=${it.hidden}, stale=${stale}, indexed=${indexed}) =====`
        );
        await blank();
        continue;
      }

      const sha = await sha256HexFile(it.uri.fsPath);

      // read bytes (truncate if maxFileBytes set)
      const want = opts.maxFileBytes > 0 ? Math.min(size, opts.maxFileBytes) : size;
      const buf = await readUpTo(it.uri.fsPath, want);

      const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      const lines = countNewlines(text);

      await writeln(
        `===== FILE: ${it.rel} (bytes=${size}, lines=${lines}, sha256=${sha}, hidden=${it.hidden}, stale=${stale}, indexed=${indexed}) =====`
      );

      if (opts.listOnly) {
        await blank();
        stats.includedWritten++;
        continue;
      }

      // fences
      let openedFence = false;
      if (!opts.noFences) {
        const lang = langForRel(it.rel);
        await writeln(lang ? `\`\`\`${lang}` : "```");
        openedFence = true;
      }

      // content
      await write(text);

      if (openedFence) {
        await writeln("");
        await writeln("```");
      }

      if (opts.maxFileBytes > 0 && size > opts.maxFileBytes) {
        stats.truncatedFiles++;
        await writeln(`<<< TRUNCATED to ${opts.maxFileBytes} bytes (original: ${size} bytes) >>>`);
      }

      await blank();

      stats.includedWritten++;
      stats.totalBytesWritten += buf.byteLength;

      // max-total check after write (matches bash behavior)
      if (opts.maxTotalBytes > 0 && stats.totalBytesWritten >= opts.maxTotalBytes) {
        stats.stoppedByMaxTotal = true;
        await writeln(`### Reached --max-total=${opts.maxTotalBytes} bytes. Stopping.`);
        break;
      }
    }
  } catch (err) {
    log.caught("contextDumpWriter.writeContextDump", err);
    throw err;
  } finally {
    await new Promise<void>((resolve) => ws.end(resolve));
  }

  return { cancelled };
}
