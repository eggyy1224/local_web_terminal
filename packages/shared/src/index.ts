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

export type PaneRole = "workspace" | "coding_agent" | "tool";

export interface PaneView {
  id: string;
  isActive: boolean;
  role: PaneRole;
  lines: string[];
  cwd: string;
  title?: string;
  currentCommand?: string;
  errors?: string[];
  lastInteractedAt?: number;
  capturedAt?: number;
  stale?: boolean;
  workspaceKind?: WorkspaceKind;
  repoRoot?: string;
  gitSnapshot?: PaneGitSnapshot | null;
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
  panes: PaneView[];
}

export interface EnvContext {
  activePaneId: string;
  role: PaneRole;
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

export type ContextSnapshotReason = "connect" | "stdout" | "submit" | "resize" | "heartbeat";

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
    }
  | {
      type: "meta";
      data: {
        kind: "context_snapshot";
        snapshot: SessionContext;
        updatedAt: number;
        reason: ContextSnapshotReason;
      };
    };

export const LOCAL_ORIGIN_DEFAULT = "http://127.0.0.1:5173,http://localhost:5173";
