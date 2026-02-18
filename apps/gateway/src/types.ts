import type { CommandProposal, SplitDirection, TmuxTopology } from "@local-terminal/shared";

export interface PaneContext {
  cwd: string;
  shell: string;
}

export interface TerminalAdapter {
  createSession(sessionId: string, cols: number, rows: number): Promise<{ activePaneId: string }>;
  createTab(sessionId: string): Promise<{ activePaneId: string }>;
  splitPane(sessionId: string, direction: SplitDirection): Promise<{ paneId: string }>;
  listTopology(sessionId: string): Promise<TmuxTopology>;
  selectPane(sessionId: string, paneId: string): Promise<void>;
  getActivePane(sessionId: string): Promise<string>;
  getPaneContext(sessionId: string): Promise<PaneContext>;
  sendCommandToActivePane(sessionId: string, command: string): Promise<{ paneId: string }>;
  ensureSessionExists(sessionId: string): Promise<boolean>;
}

export interface SessionState {
  sessionId: string;
  activePane: string;
  outputChunks: string[];
  lastCommands: string[];
  currentInput: string;
  riskFlags: string[];
  shell: string;
  cwd: string;
}

export interface ProposalState {
  proposal: CommandProposal;
  confirmed: boolean;
}
