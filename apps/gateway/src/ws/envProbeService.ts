import type { EnvContext, PaneRole } from "@local-terminal/shared";
import { classifyPaneRole, probeWorkspace } from "../services/contextCollector.js";
import type { SessionStore } from "../services/sessionStore.js";
import type { PaneSnapshot, TerminalAdapter } from "../types.js";
import type { AppLogger } from "../utils/logger.js";

const OPEN = 1;

async function resolveRole(
  activePaneId: string,
  panes: PaneSnapshot[],
  fallback: { currentCommand: string; title: string; currentPath: string }
): Promise<PaneRole> {
  const paneByActivePaneId = activePaneId ? panes.find((pane) => pane.id === activePaneId) ?? null : null;
  if (activePaneId && !paneByActivePaneId) {
    const workspace = await probeWorkspace(fallback.currentPath);
    return classifyPaneRole({
      currentCommand: fallback.currentCommand,
      title: fallback.title,
      workspaceKind: workspace.kind
    });
  }

  const activePane = paneByActivePaneId ?? panes.find((pane) => pane.active) ?? null;
  if (activePane) {
    const workspace = await probeWorkspace(activePane.currentPath);
    return classifyPaneRole({
      currentCommand: activePane.currentCommand,
      title: activePane.title,
      workspaceKind: workspace.kind
    });
  }

  const workspace = await probeWorkspace(fallback.currentPath);
  return classifyPaneRole({
    currentCommand: fallback.currentCommand,
    title: fallback.title,
    workspaceKind: workspace.kind
  });
}

interface EnvProbeSocketLike {
  readyState: number;
  send(payload: string): void;
}

export interface EnvProbeServiceOptions {
  sessionId: string;
  store: SessionStore;
  adapter: TerminalAdapter;
  socket: EnvProbeSocketLike;
  probeTargetPromise: Promise<string | null>;
  logger?: AppLogger;
}

export interface EnvProbeService {
  runHiddenEnvironmentProbe(): Promise<void>;
}

export function createEnvProbeService(options: EnvProbeServiceOptions): EnvProbeService {
  const { sessionId, store, adapter, socket, probeTargetPromise, logger } = options;
  const RETRY_DELAYS_MS = [280, 700];

  const runHiddenEnvironmentProbe = async () => {
    const version = store.nextEnvProbeVersion(sessionId);
    if (version <= 0) {
      return;
    }

    const runAttempt = async (attempt: number): Promise<boolean> => {
      try {
        let raw: Awaited<ReturnType<TerminalAdapter["probeActiveEnvironment"]>> | null = null;
        let usedTarget = sessionId;
        let lastProbeError: unknown = null;
        const baseProbeTarget = await probeTargetPromise.catch((error) => {
          lastProbeError = error;
          return null;
        });
        const candidateTargets = Array.from(
          new Set([
            ...(typeof baseProbeTarget === "string" && baseProbeTarget.trim().length > 0 ? [baseProbeTarget.trim()] : []),
            sessionId
          ])
        );

        for (const target of candidateTargets) {
          try {
            const candidateRaw = await adapter.probeActiveEnvironment(sessionId, target);
            const hasTmuxIdentity = Boolean(candidateRaw.tmux.session || candidateRaw.tmux.window || candidateRaw.tmux.pane);
            if (!hasTmuxIdentity) {
              continue;
            }
            raw = candidateRaw;
            usedTarget = target;
            break;
          } catch (error) {
            lastProbeError = error;
          }
        }

        if (!raw) {
          throw lastProbeError instanceof Error ? lastProbeError : new Error("env probe returned no candidate data");
        }

        let role: PaneRole = "tool";
        try {
          const panes = await adapter.listPanes(sessionId, usedTarget);
          role = await resolveRole(raw.activePaneId, panes, {
            currentCommand: raw.paneCurrentCommand,
            title: raw.paneTitle,
            currentPath: raw.paneCurrentPath
          });
        } catch (error) {
          logger?.warn({ code: "env_probe_list_panes_failed", sessionId, error });
          const workspace = await probeWorkspace(raw.paneCurrentPath);
          role = classifyPaneRole({
            currentCommand: raw.paneCurrentCommand,
            title: raw.paneTitle,
            workspaceKind: workspace.kind
          });
        }

        const env: EnvContext = {
          activePaneId: raw.activePaneId,
          role,
          realCwd: raw.paneCurrentPath,
          repoRoot: raw.repoRoot,
          isGitRepo: raw.isGitRepo,
          tmux: raw.tmux,
          capturedAt: Date.now(),
          version
        };

        store.setLatestEnvContext(sessionId, env);
        if (socket.readyState !== OPEN) {
          return true;
        }

        socket.send(
          JSON.stringify({
            type: "meta",
            data: {
              kind: "env_probe",
              env
            }
          })
        );
        return true;
      } catch (error) {
        if (socket.readyState !== OPEN) {
          return false;
        }
        const delayMs = RETRY_DELAYS_MS[attempt];
        if (delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return runAttempt(attempt + 1);
        }
        logger?.warn({ code: "env_probe_failed", sessionId, error });
        return false;
      }
    };

    await runAttempt(0);
  };

  return { runHiddenEnvironmentProbe };
}
