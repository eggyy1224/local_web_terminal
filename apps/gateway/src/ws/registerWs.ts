import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pty from "node-pty";
import type { ContextSnapshotReason, EnvContext, PaneRole } from "@local-terminal/shared";
import { z } from "zod";
import { attachCommand } from "../adapters/tmuxAdapter.js";
import { classifyPaneRole, probeWorkspace } from "../services/contextCollector.js";
import { buildSessionContextSnapshot, type ContextSnapshotDeps } from "../services/contextSnapshot.js";
import type { PaneSnapshot } from "../types.js";
import { isLoopbackOrigin } from "../utils/origin.js";

const execFileAsync = promisify(execFile);

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdin"), data: z.string() }),
  z.object({ type: z.literal("resize"), data: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }) })
]);

const REASON_PRIORITY: Record<ContextSnapshotReason, number> = {
  connect: 5,
  submit: 4,
  heartbeat: 3,
  resize: 2,
  stdout: 1
};

function pickHighestPriorityReason(reasons: Set<ContextSnapshotReason>): ContextSnapshotReason {
  let best: ContextSnapshotReason = "stdout";
  let bestScore = -1;
  for (const reason of reasons) {
    const score = REASON_PRIORITY[reason] ?? 0;
    if (score > bestScore) {
      best = reason;
      bestScore = score;
    }
  }
  return best;
}

export async function registerWsRoutes(
  app: FastifyInstance,
  deps: ContextSnapshotDeps & { originAllowList: Set<string> }
): Promise<void> {
  const resolveClientTargetByPid = async (pid: number): Promise<string | null> => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }

    try {
      const { stdout } = await execFileAsync("ps", ["-o", "tty=", "-p", String(pid)], {
        timeout: 120,
        maxBuffer: 16 * 1024
      });
      const tty = stdout.trim();
      if (!tty || tty === "??") {
        return null;
      }
      return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    } catch {
      return null;
    }
  };

  const hasSubmitBoundary = (data: string): boolean => data.includes("\r") || data.includes("\n");

  const resolveRole = async (
    activePaneId: string,
    panes: PaneSnapshot[],
    fallback: { currentCommand: string; title: string; currentPath: string }
  ): Promise<PaneRole> => {
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
  };

  app.get("/ws/sessions/:sessionId/stream", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin && !deps.originAllowList.has(origin) && !isLoopbackOrigin(origin)) {
      socket.send(JSON.stringify({ type: "error", data: "origin_not_allowed" }));
      socket.close();
      return;
    }

    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const sessionId = params.sessionId;
    const contextPushDebounceMs = Number.parseInt(process.env.CONTEXT_PUSH_DEBOUNCE_MS ?? "300", 10) || 300;
    const contextPushHeartbeatMs = Number.parseInt(process.env.CONTEXT_PUSH_HEARTBEAT_MS ?? "15000", 10) || 15_000;
    deps.store.ensure(sessionId);
    let probeTargetPromise: Promise<string | null> | null = null;
    let contextPushInFlight = false;
    let contextPushPendingUrgent = false;
    let contextPushLastAt = 0;
    const contextPushPendingReasons = new Set<ContextSnapshotReason>();
    let contextPushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let contextPushHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let contextPushDisposed = false;

    const clearContextPushDebounce = () => {
      if (contextPushDebounceTimer !== null) {
        clearTimeout(contextPushDebounceTimer);
        contextPushDebounceTimer = null;
      }
    };

    const disposeContextPush = () => {
      contextPushDisposed = true;
      clearContextPushDebounce();
      if (contextPushHeartbeatTimer !== null) {
        clearInterval(contextPushHeartbeatTimer);
        contextPushHeartbeatTimer = null;
      }
      contextPushPendingReasons.clear();
      contextPushPendingUrgent = false;
    };

    const flushContextSnapshotPush = async (forceImmediate: boolean) => {
      if (contextPushDisposed || socket.readyState !== 1 || contextPushInFlight || contextPushPendingReasons.size === 0) {
        return;
      }

      if (!forceImmediate) {
        const elapsed = Date.now() - contextPushLastAt;
        if (elapsed < contextPushDebounceMs) {
          if (contextPushDebounceTimer === null) {
            const delay = Math.max(1, contextPushDebounceMs - elapsed);
            contextPushDebounceTimer = setTimeout(() => {
              contextPushDebounceTimer = null;
              void flushContextSnapshotPush(false);
            }, delay);
          }
          return;
        }
      }

      clearContextPushDebounce();
      const reason = pickHighestPriorityReason(contextPushPendingReasons);
      contextPushPendingReasons.clear();
      contextPushPendingUrgent = false;
      contextPushInFlight = true;
      try {
        const snapshot = await buildSessionContextSnapshot(sessionId, deps);
        if (!snapshot || contextPushDisposed || socket.readyState !== 1) {
          return;
        }

        const updatedAt = Date.now();
        contextPushLastAt = updatedAt;
        socket.send(
          JSON.stringify({
            type: "meta",
            data: {
              kind: "context_snapshot",
              snapshot,
              updatedAt,
              reason
            }
          })
        );
      } catch {
        // Silent fallback: keep terminal behavior unchanged when context snapshot push fails.
      } finally {
        contextPushInFlight = false;
        if (contextPushDisposed || socket.readyState !== 1 || contextPushPendingReasons.size === 0) {
          return;
        }

        if (contextPushPendingUrgent) {
          void flushContextSnapshotPush(true);
          return;
        }

        const elapsed = Date.now() - contextPushLastAt;
        if (elapsed >= contextPushDebounceMs) {
          void flushContextSnapshotPush(false);
          return;
        }

        if (contextPushDebounceTimer === null) {
          const delay = Math.max(1, contextPushDebounceMs - elapsed);
          contextPushDebounceTimer = setTimeout(() => {
            contextPushDebounceTimer = null;
            void flushContextSnapshotPush(false);
          }, delay);
        }
      }
    };

    const queueContextSnapshotPush = (reason: ContextSnapshotReason, urgent = false) => {
      if (contextPushDisposed) {
        return;
      }

      contextPushPendingReasons.add(reason);

      if (urgent) {
        contextPushPendingUrgent = true;
        clearContextPushDebounce();
        void flushContextSnapshotPush(true);
        return;
      }

      if (contextPushInFlight) {
        return;
      }

      const elapsed = Date.now() - contextPushLastAt;
      if (elapsed >= contextPushDebounceMs) {
        void flushContextSnapshotPush(false);
        return;
      }

      if (contextPushDebounceTimer === null) {
        const delay = Math.max(1, contextPushDebounceMs - elapsed);
        contextPushDebounceTimer = setTimeout(() => {
          contextPushDebounceTimer = null;
          void flushContextSnapshotPush(false);
        }, delay);
      }
    };

    const runHiddenEnvironmentProbe = async () => {
      const version = deps.store.nextEnvProbeVersion(sessionId);
      if (version <= 0) {
        return;
      }

      try {
        const probeTarget = (await probeTargetPromise) ?? sessionId;
        const raw = await deps.adapter.probeActiveEnvironment(sessionId, probeTarget);
        let role: PaneRole = "tool";
        try {
          const panes = await deps.adapter.listPanes(sessionId, probeTarget);
          role = await resolveRole(raw.activePaneId, panes, {
            currentCommand: raw.paneCurrentCommand,
            title: raw.paneTitle,
            currentPath: raw.paneCurrentPath
          });
        } catch {
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

        deps.store.setLatestEnvContext(sessionId, env);
        if (socket.readyState !== 1) {
          return;
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
      } catch {
        // Silent fallback: keep terminal behavior unchanged when probe fails.
      }
    };

    const cmd = attachCommand(sessionId);
    const term = pty.spawn(cmd.file, cmd.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 35,
      cwd: process.cwd(),
      env: process.env
    });
    probeTargetPromise = resolveClientTargetByPid(term.pid ?? 0);
    contextPushHeartbeatTimer = setInterval(() => {
      queueContextSnapshotPush("heartbeat", true);
    }, contextPushHeartbeatMs);
    queueContextSnapshotPush("connect", true);

    term.onData((data) => {
      deps.store.appendStdout(sessionId, data);
      socket.send(JSON.stringify({ type: "stdout", data }));
      queueContextSnapshotPush("stdout");
    });

    term.onExit(({ exitCode, signal }) => {
      socket.send(JSON.stringify({ type: "exit", data: { exitCode, signal } }));
      socket.close();
    });

    socket.on("message", (raw: string | Buffer) => {
      let parsed;
      try {
        parsed = messageSchema.parse(JSON.parse(raw.toString()));
      } catch {
        socket.send(JSON.stringify({ type: "error", data: "invalid_message" }));
        return;
      }

      if (parsed.type === "stdin") {
        deps.store.appendInput(sessionId, parsed.data);
        term.write(parsed.data);
        if (hasSubmitBoundary(parsed.data)) {
          void runHiddenEnvironmentProbe();
          queueContextSnapshotPush("submit", true);
        }
        return;
      }

      term.resize(parsed.data.cols, parsed.data.rows);
      queueContextSnapshotPush("resize");
    });

    socket.on("close", () => {
      disposeContextPush();
      term.kill();
    });
  });
}
