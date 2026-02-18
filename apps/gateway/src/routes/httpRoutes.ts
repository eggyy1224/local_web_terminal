import type { FastifyInstance } from "fastify";
import type { SessionContext, TwoPaneView } from "@local-terminal/shared";
import { maskSensitive } from "@local-terminal/security";
import { z } from "zod";
import {
  collectGitSnapshotByRepoRoot,
  isCodexPaneSignal,
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

function createUnavailablePane(role: "codex" | "workspace"): TwoPaneView {
  if (role === "workspace") {
    return {
      id: "",
      isActive: false,
      lines: [],
      role,
      workspaceKind: "unknown",
      gitSnapshot: null,
      errors: []
    };
  }

  return {
    id: "",
    isActive: false,
    lines: [],
    role,
    errors: []
  };
}

function pickCodexPane(panes: PaneSnapshot[]): PaneSnapshot | null {
  const codexCandidates = panes.filter((pane) =>
    isCodexPaneSignal({
      currentCommand: pane.currentCommand,
      title: pane.title
    })
  );
  if (codexCandidates.length === 0) {
    return null;
  }
  return codexCandidates.find((pane) => pane.active) ?? codexCandidates[0];
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
  } catch (error) {
    runtimeErrors.push(paneError("tmux_active_pane_failed", error));
  }

  let tmuxPanes: PaneSnapshot[] = [];
  try {
    tmuxPanes = await deps.adapter.listPanes(sessionId);
  } catch (error) {
    runtimeErrors.push(paneError("tmux_list_panes_failed", error));
  }

  const codexPane = pickCodexPane(tmuxPanes);
  const workspaceCandidates = tmuxPanes.filter((pane) => !codexPane || pane.id !== codexPane.id);
  const workspaceProbeResults = await Promise.all(
    workspaceCandidates.map(async (pane) => ({
      pane,
      workspace: await probeWorkspace(pane.currentPath)
    }))
  );

  const repoWorkspaceCandidates = workspaceProbeResults.filter(
    (entry) => entry.workspace.kind === "git_repo_root" || entry.workspace.kind === "git_repo_subdir"
  );
  const pickedWorkspaceProbe =
    repoWorkspaceCandidates.find((entry) => entry.pane.active) ?? repoWorkspaceCandidates[0] ?? workspaceProbeResults[0] ?? null;

  const gitSnapshotCache = new Map<string, Awaited<ReturnType<typeof collectGitSnapshotByRepoRoot>>>();
  const readGitByRepoRoot = async (repoRoot: string, paneErrors: string[], paneId: string) => {
    if (!repoRoot) {
      return null;
    }

    if (!gitSnapshotCache.has(repoRoot)) {
      try {
        const snapshot = await collectGitSnapshotByRepoRoot(repoRoot);
        gitSnapshotCache.set(repoRoot, snapshot);
      } catch (error) {
        paneErrors.push(paneError("git_snapshot_failed", error, paneId));
        return null;
      }
    }

    return gitSnapshotCache.get(repoRoot) ?? null;
  };

  const codexView = createUnavailablePane("codex");
  if (!codexPane) {
    codexView.errors = ["codex_pane_unavailable"];
  } else {
    codexView.id = codexPane.id;
    codexView.title = codexPane.title || undefined;
    codexView.cwd = codexPane.currentPath || undefined;
    codexView.isActive = codexPane.active || codexPane.id === activePaneId;
    try {
      codexView.lines = await deps.adapter.capturePaneLines(sessionId, codexPane.id, PANE_LINES_LIMIT);
    } catch (error) {
      codexView.lines = [];
      codexView.errors = [paneError("tmux_capture_failed", error, codexPane.id)];
    }
  }

  const workspaceView = createUnavailablePane("workspace");
  if (!pickedWorkspaceProbe) {
    workspaceView.errors = ["workspace_pane_unavailable"];
  } else {
    const workspacePane = pickedWorkspaceProbe.pane;
    const workspaceProbe = pickedWorkspaceProbe.workspace;
    workspaceView.id = workspacePane.id;
    workspaceView.title = workspacePane.title || undefined;
    workspaceView.cwd = workspacePane.currentPath || undefined;
    workspaceView.isActive = workspacePane.active || workspacePane.id === activePaneId;
    workspaceView.workspaceKind = workspaceProbe.kind;
    try {
      workspaceView.lines = await deps.adapter.capturePaneLines(sessionId, workspacePane.id, PANE_LINES_LIMIT);
    } catch (error) {
      workspaceView.lines = [];
      workspaceView.errors = [paneError("tmux_capture_failed", error, workspacePane.id)];
    }

    if (workspaceProbe.repoRoot) {
      workspaceView.workspaceKind = workspaceProbe.kind;
      workspaceView.repoRoot = workspaceProbe.repoRoot;
      const errors = workspaceView.errors ?? [];
      const snapshot = await readGitByRepoRoot(workspaceProbe.repoRoot, errors, workspacePane.id);
      workspaceView.errors = errors;
      workspaceView.gitSnapshot = snapshot ? toPaneGitSnapshot(snapshot) : null;
    } else if (workspaceView.workspaceKind === "unknown") {
      workspaceView.workspaceKind = workspacePane.currentPath ? "plain_dir" : "unknown";
      workspaceView.gitSnapshot = null;
    } else {
      workspaceView.gitSnapshot = null;
    }
  }

  const legacyWorkspace = await probeWorkspace(cwd);
  const legacyGitSnapshot = legacyWorkspace.repoRoot
    ? await readGitByRepoRoot(legacyWorkspace.repoRoot, runtimeErrors, activePaneId || "unknown")
    : null;

  const mergedRecentErrors = [...context.recentErrors, ...runtimeErrors];
  for (const err of codexView.errors ?? []) {
    mergedRecentErrors.push(err);
  }
  for (const err of workspaceView.errors ?? []) {
    mergedRecentErrors.push(err);
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
    twoPane: {
      activePaneId,
      codex: codexView,
      workspace: workspaceView
    }
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
      twoPane: snapshot.twoPane,
      recentErrors: snapshot.recentErrors
    });
  });
}
