import * as vscode from "vscode";
import { ConfigService } from "../../storage/configService";
import { OpenAIService } from "../../openai/openaiService";
import { StoragePaths } from "../../storage/paths";
import { log } from "../../logging/logger";

import { WebviewIn, WebviewOut } from "./configContract";

export type ConfigDeps = {
  paths: StoragePaths;
  config: ConfigService;
  openai: OpenAIService;
};

export type ConfigHost = {
  post(payload: WebviewOut): void;
  status(text: string): void;
  error(text: string): void;
};

export async function sendConfig(host: ConfigHost, deps: ConfigDeps): Promise<void> {
  await deps.config.ensure();
  const apiKeySet = await deps.openai.hasApiKey();

  host.post({
    type: "config",
    payload: {
      configPath: deps.paths.configUri.fsPath,
      apiKeySet,
      data: deps.config.data,
    },
  });
}

export async function handleConfigMessage(host: ConfigHost, deps: ConfigDeps, msg: WebviewIn): Promise<void> {
  if (msg.type === "ready" || msg.type === "refresh") {
    await sendConfig(host, deps);
    return;
  }

  if (msg.type === "openConfig") {
    await vscode.commands.executeCommand("idyicyanere.openConfig");
    return;
  }

  if (msg.type === "setApiKey") {
    await vscode.commands.executeCommand("idyicyanere.setApiKey");
    await sendConfig(host, deps);
    return;
  }

  if (msg.type === "showLogs") {
    await vscode.commands.executeCommand("idyicyanere.showLogs");
    return;
  }

  if (msg.type === "refreshAll") {
    await vscode.commands.executeCommand("idyicyanere.refresh");
    await sendConfig(host, deps);
    return;
  }

  if (msg.type === "normalizeConfig") {
    // Writes merged/defaulted config out to disk so it includes all fields.
    await deps.config.ensure();
    await deps.config.save();
    log.info("config.json normalized (rewritten with merged defaults)");
    await sendConfig(host, deps);
    return;
  }

  if (msg.type === "clientError") {
    log.error("Config webview JS error", { text: msg.text, stack: msg.stack });
    return;
  }

  host.error(`Unknown message type: ${(msg as any)?.type ?? "(missing type)"}`);
}
