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

export type WsClientMessage =
  | {
      type: "stdin";
      data: string;
    }
  | {
      type: "resize";
      data: { cols: number; rows: number };
    };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTmuxContext(value: unknown): value is EnvContext["tmux"] {
  return (
    isRecord(value) &&
    typeof value.session === "string" &&
    typeof value.window === "string" &&
    typeof value.pane === "string"
  );
}

function isPaneRole(value: unknown): value is PaneRole {
  return value === "workspace" || value === "coding_agent" || value === "tool";
}

function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return value === "git_repo_root" || value === "git_repo_subdir" || value === "plain_dir" || value === "unknown";
}

function isPaneGitSnapshot(value: unknown): value is PaneGitSnapshot {
  return (
    isRecord(value) &&
    typeof value.branch === "string" &&
    typeof value.isDirty === "boolean" &&
    (typeof value.summary === "string" || isRecord(value.summary))
  );
}

function isPaneView(value: unknown): value is PaneView {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.id !== "string" ||
    typeof value.isActive !== "boolean" ||
    !isPaneRole(value.role) ||
    !isStringArray(value.lines) ||
    typeof value.cwd !== "string"
  ) {
    return false;
  }

  if (value.title !== undefined && typeof value.title !== "string") {
    return false;
  }
  if (value.currentCommand !== undefined && typeof value.currentCommand !== "string") {
    return false;
  }
  if (value.errors !== undefined && !isStringArray(value.errors)) {
    return false;
  }
  if (value.lastInteractedAt !== undefined && !isInteger(value.lastInteractedAt)) {
    return false;
  }
  if (value.capturedAt !== undefined && !isInteger(value.capturedAt)) {
    return false;
  }
  if (value.stale !== undefined && typeof value.stale !== "boolean") {
    return false;
  }
  if (value.workspaceKind !== undefined && !isWorkspaceKind(value.workspaceKind)) {
    return false;
  }
  if (value.repoRoot !== undefined && typeof value.repoRoot !== "string") {
    return false;
  }
  if (value.gitSnapshot !== undefined && value.gitSnapshot !== null && !isPaneGitSnapshot(value.gitSnapshot)) {
    return false;
  }

  return true;
}

function isTmuxPaneSnapshot(value: unknown): value is TmuxPaneSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isInteger(value.index) &&
    typeof value.title === "string" &&
    typeof value.active === "boolean" &&
    typeof value.currentPath === "string" &&
    typeof value.currentCommand === "string"
  );
}

function isSessionContext(value: unknown): value is SessionContext {
  return (
    isRecord(value) &&
    isInteger(value.timestamp) &&
    typeof value.sessionId === "string" &&
    typeof value.cwd === "string" &&
    typeof value.repoRoot === "string" &&
    typeof value.branch === "string" &&
    typeof value.gitStatusPorcelain === "string" &&
    typeof value.diffStat === "string" &&
    isStringArray(value.recentErrors) &&
    Array.isArray(value.tmuxPanes) &&
    value.tmuxPanes.every((pane) => isTmuxPaneSnapshot(pane)) &&
    typeof value.shell === "string" &&
    isStringArray(value.recentOutput) &&
    isStringArray(value.lastCommands) &&
    Array.isArray(value.panes) &&
    value.panes.every((pane) => isPaneView(pane))
  );
}

function isEnvContext(value: unknown): value is EnvContext {
  return (
    isRecord(value) &&
    typeof value.activePaneId === "string" &&
    isPaneRole(value.role) &&
    typeof value.realCwd === "string" &&
    typeof value.repoRoot === "string" &&
    typeof value.isGitRepo === "boolean" &&
    isTmuxContext(value.tmux) &&
    isInteger(value.capturedAt) &&
    isInteger(value.version)
  );
}

export function isWsClientMessage(value: unknown): value is WsClientMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "stdin") {
    return typeof value.data === "string";
  }

  if (value.type === "resize") {
    return (
      isRecord(value.data) &&
      isInteger(value.data.cols) &&
      value.data.cols > 0 &&
      isInteger(value.data.rows) &&
      value.data.rows > 0
    );
  }

  return false;
}

export function parseWsClientMessage(value: unknown): WsClientMessage | null {
  return isWsClientMessage(value) ? value : null;
}

export function isWsServerMessage(value: unknown): value is WsServerMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "stdout" || value.type === "exit" || value.type === "error") {
    return "data" in value;
  }

  if (value.type !== "meta" || !isRecord(value.data) || typeof value.data.kind !== "string") {
    return false;
  }

  if (value.data.kind === "env_probe") {
    return isEnvContext(value.data.env);
  }

  if (value.data.kind === "context_snapshot") {
    return isSessionContext(value.data.snapshot) && isInteger(value.data.updatedAt);
  }

  return false;
}

export function parseWsServerMessage(value: unknown): WsServerMessage | null {
  return isWsServerMessage(value) ? value : null;
}
