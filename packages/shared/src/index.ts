export interface SessionContext {
  sessionId: string;
  cwd: string;
  shell: string;
  recentOutput: string[];
  lastCommands: string[];
}

export interface WsClientMessage {
  type: "stdin" | "resize";
  data: string | { cols: number; rows: number };
}

export interface WsServerMessage {
  type: "stdout" | "exit" | "error";
  data: unknown;
}

export const LOCAL_ORIGIN_DEFAULT = "http://127.0.0.1:5173,http://localhost:5173";
