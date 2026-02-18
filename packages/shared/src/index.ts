export type SplitDirection = "vertical" | "horizontal";

export interface CreateSessionResponse {
  sessionId: string;
  activePaneId: string;
}

export interface SessionContext {
  sessionId: string;
  activePane: string;
  cwd: string;
  shell: string;
  recentOutput: string[];
  runningProcessHints: string[];
  lastCommands: string[];
  riskFlags: string[];
}

export interface CommandProposal {
  id: string;
  sessionId: string;
  command: string;
  riskFlags: string[];
  explanation: string;
  createdAt: number;
}

export interface ProposeCommandRequest {
  sessionId: string;
  command: string;
}

export interface ProposeCommandResponse {
  proposal: CommandProposal;
  requiresConfirmation: boolean;
  preview: {
    command: string;
    riskFlags: string[];
    explanation: string;
  };
}

export interface ConfirmCommandResponse {
  proposalId: string;
  executed: boolean;
  paneId: string;
}

export interface PaneMeta {
  paneId: string;
  windowId: string;
  title: string;
  isActive: boolean;
}

export interface TmuxTopology {
  sessionId: string;
  windows: Array<{
    windowId: string;
    windowName: string;
    panes: PaneMeta[];
  }>;
  activePaneId: string;
}

export interface WsClientMessage {
  type: "stdin" | "resize" | "focus-pane";
  data: string | { cols: number; rows: number } | { paneId: string };
}

export interface WsServerMessage {
  type: "stdout" | "exit" | "pane-meta" | "error";
  data: unknown;
}

export const LOCAL_ORIGIN_DEFAULT = "http://127.0.0.1:5173,http://localhost:5173";
