import type { PaneView } from "@local-terminal/shared";
import {
  classifyPaneRole,
  probeWorkspace,
  toPaneGitSnapshot
} from "./contextCollector.js";
import { paneError } from "./contextErrorCollector.js";
import type { ReadGitByRepoRoot } from "./gitSnapshotCache.js";
import type { SessionStore } from "./sessionStore.js";
import type { PaneSnapshot, TerminalAdapter } from "../types.js";
import type { AppLogger } from "../utils/logger.js";

function markPaneStale(pane: PaneView, now: number, paneStateTtlMs: number): PaneView {
  const capturedAt = pane.capturedAt ?? 0;
  return {
    ...pane,
    stale: capturedAt > 0 ? now - capturedAt > paneStateTtlMs : true
  };
}

function sortPanes(panes: PaneView[], paneIndexById: Map<string, number>): PaneView[] {
  return [...panes].sort((a, b) => {
    if (a.isActive !== b.isActive) {
      return a.isActive ? -1 : 1;
    }

    const aInteractedAt = (a.stale ?? false) ? 0 : (a.lastInteractedAt ?? 0);
    const bInteractedAt = (b.stale ?? false) ? 0 : (b.lastInteractedAt ?? 0);
    if (aInteractedAt !== bInteractedAt) {
      return bInteractedAt - aInteractedAt;
    }

    if ((a.stale ?? false) !== (b.stale ?? false)) {
      return (a.stale ?? false) ? 1 : -1;
    }

    const aIndex = paneIndexById.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = paneIndexById.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return aIndex - bIndex;
  });
}

export interface AssemblePaneViewsInput {
  sessionId: string;
  adapter: TerminalAdapter;
  store: SessionStore;
  tmuxPanes: PaneSnapshot[];
  activePaneId: string;
  now: number;
  paneLinesLimit: number;
  paneStateTtlMs: number;
  readGitByRepoRoot: ReadGitByRepoRoot;
  logger?: AppLogger;
}

export async function assemblePaneViews(input: AssemblePaneViewsInput): Promise<PaneView[]> {
  const {
    sessionId,
    adapter,
    store,
    tmuxPanes,
    activePaneId,
    now,
    paneLinesLimit,
    paneStateTtlMs,
    readGitByRepoRoot,
    logger
  } = input;
  const paneIndexById = new Map<string, number>();
  const cachedPanes = store.getLatestPanes(sessionId);
  const cachedById = new Map(cachedPanes.map((pane) => [pane.id, pane]));

  if (tmuxPanes.length === 0) {
    return sortPanes(
      cachedPanes.map((pane) =>
        markPaneStale(
          {
            ...pane,
            isActive: activePaneId ? pane.id === activePaneId : pane.isActive
          },
          now,
          paneStateTtlMs
        )
      ),
      paneIndexById
    );
  }

  for (const pane of tmuxPanes) {
    paneIndexById.set(pane.id, pane.index);
    if (pane.active) {
      store.updatePaneInteraction(sessionId, pane.id, now);
    }
  }

  const workspaceByPane = new Map(
    await Promise.all(
      tmuxPanes.map(async (pane) => {
        const workspace = await probeWorkspace(pane.currentPath);
        return [pane.id, workspace] as const;
      })
    )
  );

  const panes = await Promise.all(
    tmuxPanes.map(async (pane) => {
      const paneErrors: string[] = [];
      const previous = cachedById.get(pane.id);
      let lines = previous?.lines ?? [];
      let capturedAt = previous?.capturedAt ?? 0;
      try {
        lines = await adapter.capturePaneLines(sessionId, pane.id, paneLinesLimit);
        capturedAt = now;
      } catch (error) {
        logger?.warn({ code: "tmux_capture_failed", sessionId, paneId: pane.id, error });
        paneErrors.push(paneError("tmux_capture_failed", error, pane.id));
      }

      const workspace = workspaceByPane.get(pane.id) ?? { kind: "unknown" as const, repoRoot: "" };
      const role = classifyPaneRole({
        currentCommand: pane.currentCommand,
        title: pane.title,
        lines,
        workspaceKind: workspace.kind
      });

      const view: PaneView = {
        id: pane.id,
        isActive: pane.active || pane.id === activePaneId,
        role,
        lines,
        cwd: pane.currentPath || "",
        title: pane.title || undefined,
        currentCommand: pane.currentCommand || undefined,
        errors: paneErrors,
        workspaceKind: workspace.kind,
        capturedAt,
        lastInteractedAt: store.getPaneInteraction(sessionId, pane.id) ?? undefined
      };

      if (workspace.repoRoot) {
        view.repoRoot = workspace.repoRoot;
        const snapshot = await readGitByRepoRoot(workspace.repoRoot, paneErrors, pane.id);
        view.gitSnapshot = snapshot ? toPaneGitSnapshot(snapshot) : null;
      } else {
        view.gitSnapshot = null;
      }

      return markPaneStale(view, now, paneStateTtlMs);
    })
  );

  return sortPanes(panes, paneIndexById);
}
