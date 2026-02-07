import * as vscode from "vscode";
import { log } from "../logging/logger";
import { OpenAIService } from "../openai/openaiService";

export async function runSetApiKeyCommand(openai: OpenAIService): Promise<void> {
  log.info("Command: idyicyanere.setApiKey");

  const key = await vscode.window.showInputBox({
    prompt: "Enter OpenAI API key",
    password: true,
    ignoreFocusOut: true
  });

  if (key) await openai.setApiKey(key);
}
