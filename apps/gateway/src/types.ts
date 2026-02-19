import type { EnvContext, PaneView } from "@local-terminal/shared";

export interface PaneContext {
  cwd: string;
  shell: string;
}

export interface PaneSnapshot {
  id: string;
  index: number;
  title: string;
  active: boolean;
  currentPath: string;
  currentCommand: string;
}

export interface ActiveEnvironmentProbe {
  activePaneId: string;
  paneCurrentPath: string;
  paneCurrentCommand: string;
  paneTitle: string;
  tmux: {
    session: string;
    window: string;
    pane: string;
  };
  repoRoot: string;
  isGitRepo: boolean;
}

export interface TerminalAdapter {
  createSession(sessionId: string, cols: number, rows: number): Promise<{ activePaneId: string }>;
  getActivePane(sessionId: string): Promise<string>;
  getPaneContext(sessionId: string): Promise<PaneContext>;
  probeActiveEnvironment(sessionId: string, probeTarget?: string): Promise<ActiveEnvironmentProbe>;
  listPanes(sessionId: string, probeTarget?: string): Promise<PaneSnapshot[]>;
  capturePaneLines(sessionId: string, paneId: string, limit: number): Promise<string[]>;
  ensureSessionExists(sessionId: string): Promise<boolean>;
}

export interface SessionState {
  sessionId: string;
  outputChunks: string[];
  lastCommands: string[];
  currentInput: string;
  shell: string;
  cwd: string;
  envProbeVersion: number;
  paneInteractionById: Record<string, number>;
  latestPanes: PaneView[];
  latestEnvContext?: EnvContext;
}
