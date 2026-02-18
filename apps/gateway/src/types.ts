export interface PaneContext {
  cwd: string;
  shell: string;
}

export interface TerminalAdapter {
  createSession(sessionId: string, cols: number, rows: number): Promise<{ activePaneId: string }>;
  getActivePane(sessionId: string): Promise<string>;
  getPaneContext(sessionId: string): Promise<PaneContext>;
  ensureSessionExists(sessionId: string): Promise<boolean>;
}

export interface SessionState {
  sessionId: string;
  outputChunks: string[];
  lastCommands: string[];
  currentInput: string;
  shell: string;
  cwd: string;
}
