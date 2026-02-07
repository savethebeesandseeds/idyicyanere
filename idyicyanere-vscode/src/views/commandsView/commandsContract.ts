export type Cmd = { id: string };

export type WebviewOut =
  | { type: "commands"; commands: Cmd[] }
  | { type: "error"; text: string }
  | { type: "log"; text: string };

export type WebviewIn =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "run"; id: string }
  | { type: "clientError"; text: string; stack?: string };
