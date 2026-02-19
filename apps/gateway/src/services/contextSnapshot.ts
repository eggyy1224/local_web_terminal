import type { SessionContext } from "@local-terminal/shared";
import { probeWorkspace } from "./contextCollector.js";
import { mergeRecentErrors, paneError } from "./contextErrorCollector.js";
import { createGitSnapshotReader } from "./gitSnapshotCache.js";
import { assemblePaneViews } from "./paneSnapshotAssembler.js";
import type { SessionStore } from "./sessionStore.js";
import type { PaneSnapshot, TerminalAdapter } from "../types.js";
import type { AppLogger } from "../utils/logger.js";

const PANE_LINES_LIMIT = Number.parseInt(process.env.SNAPSHOT_PANE_LINES ?? "200", 10) || 200;
const PANE_STATE_TTL_MS = Number.parseInt(process.env.PANE_STATE_TTL_MS ?? "10000", 10) || 10_000;

export interface ContextSnapshotDeps {
  adapter: TerminalAdapter;
  store: SessionStore;
  logger?: AppLogger;
}

async function readPaneContext(
  sessionId: string,
  deps: ContextSnapshotDeps
): Promise<{ paneCwd: string | null; paneShell: string | null }> {
  try {
    const paneContext = await deps.adapter.getPaneContext(sessionId);
    deps.store.setContext(sessionId, {
      cwd: paneContext.cwd || process.cwd(),
      shell: paneContext.shell || ""
    });
    return {
      paneCwd: paneContext.cwd || null,
      paneShell: paneContext.shell || null
    };
  } catch (error) {
    deps.logger?.warn({ code: "tmux_pane_context_failed", sessionId, error });
    return { paneCwd: null, paneShell: null };
  }
}

async function readActivePane(sessionId: string, deps: ContextSnapshotDeps, runtimeErrors: string[]): Promise<string> {
  try {
    const activePaneId = await deps.adapter.getActivePane(sessionId);
    if (activePaneId) {
      deps.store.updatePaneInteraction(sessionId, activePaneId, Date.now());
    }
    return activePaneId;
  } catch (error) {
    deps.logger?.warn({ code: "tmux_active_pane_failed", sessionId, error });
    runtimeErrors.push(paneError("tmux_active_pane_failed", error));
    return "";
  }
}

async function readTmuxPanes(
  sessionId: string,
  deps: ContextSnapshotDeps,
  runtimeErrors: string[]
): Promise<PaneSnapshot[]> {
  try {
    return await deps.adapter.listPanes(sessionId);
  } catch (error) {
    deps.logger?.warn({ code: "tmux_list_panes_failed", sessionId, error });
    runtimeErrors.push(paneError("tmux_list_panes_failed", error));
    return [];
  }
}

export async function buildSessionContextSnapshot(
  sessionId: string,
  deps: ContextSnapshotDeps
): Promise<SessionContext | null> {
  const exists = await deps.adapter.ensureSessionExists(sessionId);
  if (!exists) {
    return null;
  }

  deps.store.ensure(sessionId);
  const { paneCwd, paneShell } = await readPaneContext(sessionId, deps);

  const context = deps.store.getContext(sessionId);
  if (!context) {
    return null;
  }

  const runtimeErrors: string[] = [];
  const cwd = paneCwd ?? context.cwd ?? process.cwd();
  const shell = paneShell ?? context.shell ?? "";
  const activePaneId = await readActivePane(sessionId, deps, runtimeErrors);
  const tmuxPanes = await readTmuxPanes(sessionId, deps, runtimeErrors);
  const readGitByRepoRoot = createGitSnapshotReader();
  const now = Date.now();

  const panes = await assemblePaneViews({
    sessionId,
    adapter: deps.adapter,
    store: deps.store,
    tmuxPanes,
    activePaneId,
    now,
    paneLinesLimit: PANE_LINES_LIMIT,
    paneStateTtlMs: PANE_STATE_TTL_MS,
    readGitByRepoRoot,
    logger: deps.logger
  });

  if (tmuxPanes.length > 0) {
    deps.store.setLatestPanes(sessionId, panes);
  }

  const legacyWorkspace = await probeWorkspace(cwd);
  const legacyGitSnapshot = legacyWorkspace.repoRoot
    ? await readGitByRepoRoot(legacyWorkspace.repoRoot, runtimeErrors, activePaneId || "unknown")
    : null;

  return {
    ...context,
    timestamp: Date.now(),
    cwd,
    shell,
    repoRoot: legacyWorkspace.repoRoot,
    branch: legacyGitSnapshot?.branch ?? "",
    gitStatusPorcelain: legacyGitSnapshot?.gitStatusPorcelain ?? "",
    diffStat: legacyGitSnapshot?.diffStat ?? "",
    tmuxPanes,
    recentErrors: mergeRecentErrors(context.recentErrors, runtimeErrors, panes),
    panes
  };
}
