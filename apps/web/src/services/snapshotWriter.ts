import type { EnvContext, SessionContext } from "@local-terminal/shared";

interface SidecarPayload {
  context: SessionContext;
  updatedAt: number;
  envContext?: EnvContext | null;
}

interface SnapshotScriptNode {
  textContent: string | null;
}

interface SnapshotWriterDocument {
  querySelector(selector: string): SnapshotScriptNode | null;
}

interface FlattenedSnapshot extends SessionContext {
  updatedAt: number;
}

export function syncEnvContextFromSnapshot(
  context: FlattenedSnapshot,
  current: EnvContext | null
): EnvContext | null {
  const panes = Array.isArray(context.panes) ? context.panes : [];
  const activePane = panes.find((pane) => pane.isActive);
  if (!activePane) {
    return current;
  }

  const tmuxPane = current?.tmux ?? { session: "", window: "", pane: "" };
  return {
    activePaneId: activePane.id,
    role: activePane.role,
    realCwd: activePane.cwd,
    repoRoot: activePane.repoRoot ?? "",
    isGitRepo: Boolean(activePane.repoRoot),
    tmux: {
      session: tmuxPane.session,
      window: tmuxPane.window,
      pane: activePane.id
    },
    capturedAt: context.timestamp,
    version: current?.version ?? 0
  };
}

export function createEmptyContext(): SessionContext {
  return {
    timestamp: 0,
    sessionId: "",
    cwd: "",
    repoRoot: "",
    branch: "",
    gitStatusPorcelain: "",
    diffStat: "",
    recentErrors: [],
    tmuxPanes: [],
    shell: "",
    recentOutput: [],
    lastCommands: [],
    panes: []
  };
}

export function mergeIncomingContext(context: SessionContext): SessionContext {
  return {
    ...createEmptyContext(),
    ...context
  };
}

function flattenSnapshot(payload: SidecarPayload): FlattenedSnapshot {
  const empty = createEmptyContext();
  const panes = Array.isArray(payload.context.panes) ? payload.context.panes : [];
  return {
    ...empty,
    ...payload.context,
    panes: panes.map((pane) => ({
      ...pane,
      lines: Array.isArray(pane.lines) ? pane.lines : [],
      errors: Array.isArray(pane.errors) ? pane.errors : []
    })),
    updatedAt: payload.updatedAt
  };
}

function serializeSnapshot(snapshot: FlattenedSnapshot): string {
  return JSON.stringify(snapshot).replace(/</g, "\\u003c");
}

function formatEnvContext(env: EnvContext): string {
  return [
    "[ENV_CONTEXT]",
    `activePaneId: ${env.activePaneId}`,
    `role: ${env.role}`,
    `real_cwd: ${env.realCwd}`,
    `repo_root: ${env.repoRoot}`,
    `is_git_repo: ${String(env.isGitRepo)}`,
    `tmux: session=${env.tmux.session} window=${env.tmux.window} pane=${env.tmux.pane}`,
    "[/ENV_CONTEXT]"
  ].join("\n");
}

function serializeAiSnapshot(snapshot: FlattenedSnapshot, envContext: EnvContext | null): string {
  return JSON.stringify({
    sessionId: snapshot.sessionId,
    timestamp: snapshot.timestamp,
    recentErrors: snapshot.recentErrors,
    panes: snapshot.panes,
    envContext,
    envContextText: envContext ? formatEnvContext(envContext) : ""
  }).replace(/</g, "\\u003c");
}

export function writeSnapshotScripts(payload: SidecarPayload, doc: SnapshotWriterDocument = document): void {
  const flattened = flattenSnapshot(payload);
  const serialized = serializeSnapshot(flattened);
  const serializedAi = serializeAiSnapshot(flattened, payload.envContext ?? null);
  const primary = doc.querySelector("script#snapshot-json[type='application/json']");
  if (primary) {
    primary.textContent = serialized;
  }

  const alias = doc.querySelector("script#ai-context-sidecar[type='application/json']");
  if (alias) {
    alias.textContent = serialized;
  }

  const aiSnapshot = doc.querySelector("#ai-snapshot");
  if (aiSnapshot) {
    aiSnapshot.textContent = serializedAi;
  }
}

