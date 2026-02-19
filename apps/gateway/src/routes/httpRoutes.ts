import type { FastifyInstance } from "fastify";
import type { PaneView, SessionContext } from "@local-terminal/shared";
import { maskSensitive } from "@local-terminal/security";
import { z } from "zod";
import {
  classifyPaneRole,
  collectGitSnapshotByRepoRoot,
  probeWorkspace,
  toPaneGitSnapshot
} from "../services/contextCollector.js";
import type { SessionStore } from "../services/sessionStore.js";
import type { PaneSnapshot, TerminalAdapter } from "../types.js";

const createSessionBody = z.object({
  cols: z.number().int().positive().max(1000).default(120),
  rows: z.number().int().positive().max(500).default(35)
});

const snapshotQuerySchema = z.object({
  sessionId: z.string().min(1).optional()
});

const contextParamsSchema = z.object({ sessionId: z.string().min(1) });

const PANE_LINES_LIMIT = Number.parseInt(process.env.SNAPSHOT_PANE_LINES ?? "200", 10) || 200;
const PANE_STATE_TTL_MS = Number.parseInt(process.env.PANE_STATE_TTL_MS ?? "10000", 10) || 10_000;

interface RouteDeps {
  adapter: TerminalAdapter;
  store: SessionStore;
}

function paneError(code: string, error: unknown, paneId?: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const masked = maskSensitive(raw);
  const suffix = masked ? `:${masked}` : "";
  return paneId ? `${code}:${paneId}${suffix}` : `${code}${suffix}`;
}

function markPaneStale(pane: PaneView, now: number): PaneView {
  const capturedAt = pane.capturedAt ?? 0;
  return {
    ...pane,
    stale: capturedAt > 0 ? now - capturedAt > PANE_STATE_TTL_MS : true
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

async function buildSessionContextSnapshot(sessionId: string, deps: RouteDeps): Promise<SessionContext | null> {
  const exists = await deps.adapter.ensureSessionExists(sessionId);
  if (!exists) {
    return null;
  }

  deps.store.ensure(sessionId);

  let paneCwd: string | null = null;
  let paneShell: string | null = null;
  try {
    const paneContext = await deps.adapter.getPaneContext(sessionId);
    paneCwd = paneContext.cwd || null;
    paneShell = paneContext.shell || null;
    deps.store.setContext(sessionId, {
      cwd: paneContext.cwd || process.cwd(),
      shell: paneContext.shell || ""
    });
  } catch {
    // Keep context endpoint available even when tmux context lookup fails.
  }

  const context = deps.store.getContext(sessionId);
  if (!context) {
    return null;
  }

  const runtimeErrors: string[] = [];
  const cwd = paneCwd ?? context.cwd ?? process.cwd();
  const shell = paneShell ?? context.shell ?? "";
  let activePaneId = "";
  try {
    activePaneId = await deps.adapter.getActivePane(sessionId);
    if (activePaneId) {
      deps.store.updatePaneInteraction(sessionId, activePaneId, Date.now());
    }
  } catch (error) {
    runtimeErrors.push(paneError("tmux_active_pane_failed", error));
  }

  let tmuxPanes: PaneSnapshot[] = [];
  const paneIndexById = new Map<string, number>();
  const cachedPanes = deps.store.getLatestPanes(sessionId);
  const cachedById = new Map(cachedPanes.map((pane) => [pane.id, pane]));
  try {
    tmuxPanes = await deps.adapter.listPanes(sessionId);
    for (const pane of tmuxPanes) {
      paneIndexById.set(pane.id, pane.index);
      if (pane.active) {
        deps.store.updatePaneInteraction(sessionId, pane.id, Date.now());
      }
    }
  } catch (error) {
    runtimeErrors.push(paneError("tmux_list_panes_failed", error));
  }

  const gitSnapshotCache = new Map<
    string,
    Promise<{ snapshot: Awaited<ReturnType<typeof collectGitSnapshotByRepoRoot>> | null; error: unknown | null }>
  >();
  const readGitByRepoRoot = async (repoRoot: string, paneErrors: string[], paneId: string) => {
    if (!repoRoot) {
      return null;
    }

    let inFlight = gitSnapshotCache.get(repoRoot);
    if (!inFlight) {
      inFlight = collectGitSnapshotByRepoRoot(repoRoot)
        .then((snapshot) => ({ snapshot, error: null }))
        .catch((error: unknown) => ({ snapshot: null, error }));
      gitSnapshotCache.set(repoRoot, inFlight);
    }

    const result = await inFlight;
    if (result.error) {
      paneErrors.push(paneError("git_snapshot_failed", result.error, paneId));
      return null;
    }

    return result.snapshot;
  };
  const now = Date.now();
  let panes: PaneView[] = [];
  if (tmuxPanes.length === 0) {
    panes = cachedPanes.map((pane) =>
      markPaneStale(
        {
          ...pane,
          isActive: activePaneId ? pane.id === activePaneId : pane.isActive
        },
        now
      )
    );
  } else {
    const workspaceByPane = new Map(
      await Promise.all(
        tmuxPanes.map(async (pane) => {
          const workspace = await probeWorkspace(pane.currentPath);
          return [pane.id, workspace] as const;
        })
      )
    );

    panes = await Promise.all(
      tmuxPanes.map(async (pane) => {
        const paneErrors: string[] = [];
        const previous = cachedById.get(pane.id);
        let lines = previous?.lines ?? [];
        let capturedAt = previous?.capturedAt ?? 0;
        try {
          lines = await deps.adapter.capturePaneLines(sessionId, pane.id, PANE_LINES_LIMIT);
          capturedAt = now;
        } catch (error) {
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
          lastInteractedAt: deps.store.getPaneInteraction(sessionId, pane.id) ?? undefined
        };

        if (workspace.repoRoot) {
          view.repoRoot = workspace.repoRoot;
          const snapshot = await readGitByRepoRoot(workspace.repoRoot, paneErrors, pane.id);
          view.gitSnapshot = snapshot ? toPaneGitSnapshot(snapshot) : null;
        } else {
          view.gitSnapshot = null;
        }

        return markPaneStale(view, now);
      })
    );
  }

  panes = sortPanes(panes, paneIndexById);
  if (tmuxPanes.length > 0) {
    deps.store.setLatestPanes(sessionId, panes);
  }

  const legacyWorkspace = await probeWorkspace(cwd);
  const legacyGitSnapshot = legacyWorkspace.repoRoot
    ? await readGitByRepoRoot(legacyWorkspace.repoRoot, runtimeErrors, activePaneId || "unknown")
    : null;

  const mergedRecentErrors = [...context.recentErrors, ...runtimeErrors];
  for (const pane of panes) {
    for (const err of pane.errors ?? []) {
      mergedRecentErrors.push(err);
    }
  }

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
    recentErrors: mergedRecentErrors.slice(-20),
    panes
  };
}

export async function registerHttpRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get("/api/health", async () => ({ status: "ok", ts: Date.now() }));

  app.post("/api/sessions", async (request, reply) => {
    const body = createSessionBody.parse(request.body ?? {});
    const sessionId = `s_${Date.now().toString(36)}`;
    const created = await deps.adapter.createSession(sessionId, body.cols, body.rows);
    deps.store.ensure(sessionId);

    reply.send({
      sessionId,
      activePaneId: created.activePaneId
    });
  });

  app.get("/api/context/:sessionId", async (request, reply) => {
    const params = contextParamsSchema.parse(request.params);
    const snapshot = await buildSessionContextSnapshot(params.sessionId, deps);
    if (!snapshot) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }
    reply.send(snapshot);
  });

  app.get("/__snapshot.json", async (request, reply) => {
    const query = snapshotQuerySchema.parse(request.query ?? {});
    const targetSessionId = query.sessionId ?? deps.store.getMostRecentSessionId();
    if (!targetSessionId) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }

    const snapshot = await buildSessionContextSnapshot(targetSessionId, deps);
    if (!snapshot) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }

    reply.header("cache-control", "no-store");
    reply.send({
      sessionId: snapshot.sessionId,
      timestamp: snapshot.timestamp,
      panes: snapshot.panes,
      recentErrors: snapshot.recentErrors
    });
  });
}
