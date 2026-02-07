import * as vscode from "vscode";
import { log } from "../../logging/logger";
import { Cmd, WebviewIn, WebviewOut } from "./commandsContract";

export type CommandsHost = {
  post(payload: WebviewOut): void;
  error(text: string): void;
  log(text: string): void;
};

export async function sendCommands(host: CommandsHost): Promise<void> {
  const all = await vscode.commands.getCommands(true);
  const ours: Cmd[] = all
    .filter((c) => c.startsWith("idyicyanere."))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id }));

  host.post({ type: "commands", commands: ours });
}

export async function handleCommandsMessage(host: CommandsHost, msg: WebviewIn): Promise<void> {
  if (msg.type === "ready" || msg.type === "refresh") {
    await sendCommands(host);
    return;
  }

  if (msg.type === "run") {
    const id = String(msg.id ?? "").trim();
    if (!id) return;

    await vscode.commands.executeCommand(id);
    host.log(`Executed: ${id}`);
    return;
  }

  if (msg.type === "clientError") {
    log.error("Commands webview JS error", { text: msg.text, stack: msg.stack });
    return;
  }

  host.error(`Unknown message type: ${(msg as any)?.type ?? "(missing type)"}`);
}
