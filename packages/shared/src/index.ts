export interface TmuxPaneSnapshot {
  id: string;
  index: number;
  title: string;
  active: boolean;
  currentPath: string;
  currentCommand: string;
}

export type WorkspaceKind = "git_repo_root" | "git_repo_subdir" | "plain_dir" | "unknown";

export interface PaneGitSnapshot {
  branch: string;
  isDirty: boolean;
  summary: string | Record<string, unknown>;
}

export interface TwoPaneView {
  id: string;
  isActive: boolean;
  title?: string;
  cwd?: string;
  lines: string[];
  role: "codex" | "workspace";
  errors?: string[];
  workspaceKind?: WorkspaceKind;
  repoRoot?: string;
  gitSnapshot?: PaneGitSnapshot | null;
}

export interface TwoPaneSnapshot {
  activePaneId: string;
  codex: TwoPaneView;
  workspace: TwoPaneView;
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
  twoPane: TwoPaneSnapshot;
}

export interface EnvContext {
  activePaneId: string;
  role: "codex" | "workspace";
  realCwd: string;
  repoRoot: string;
  isGitRepo: boolean;
  tmux: {
    session: string;
    window: string;
    pane: string;
  };
  capturedAt: number;
  version: number;
}

export interface WsClientMessage {
  type: "stdin" | "resize";
  data: string | { cols: number; rows: number };
}

export type WsServerMessage =
  | {
      type: "stdout" | "exit" | "error";
      data: unknown;
    }
  | {
      type: "meta";
      data: {
        kind: "env_probe";
        env: EnvContext;
      };
    };

export const LOCAL_ORIGIN_DEFAULT = "http://127.0.0.1:5173,http://localhost:5173";
