export type WebviewIn =
  | { type: "ask"; text: string }
  | { type: "clear" }
  | { type: "clientError"; text: string; stack?: string };

export type WebviewOut =
  | { type: "status"; text: string }
  | { type: "answer"; question: string; answer: string }
  | { type: "error"; text: string }
  | { type: "clear" };