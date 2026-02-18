export interface TmuxPaneSnapshot {
  id: string;
  index: number;
  title: string;
  active: boolean;
  currentPath: string;
  currentCommand: string;
}

export interface SessionContext {
  timestamp: number;
  sessionId: string;
  cwd: string;
  repoRoot: string;
  branch: string;
  gitStatusPorcelain: string;
  diffStat: string;
  recentErrors: string[];
  tmuxPanes: TmuxPaneSnapshot[];
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
