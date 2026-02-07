export type WebviewIn =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "openConfig" }
  | { type: "setApiKey" }
  | { type: "showLogs" }
  | { type: "refreshAll" }
  | { type: "normalizeConfig" }
  | { type: "clientError"; text: string; stack?: string };

export type WebviewOut =
  | { type: "status"; text: string }
  | {
      type: "config";
      payload: {
        configPath: string;
        apiKeySet: boolean;
        data: any;
      };
    }
  | { type: "error"; text: string };
