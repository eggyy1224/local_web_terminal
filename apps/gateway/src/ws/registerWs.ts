import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pty from "node-pty";
import type { EnvContext } from "@local-terminal/shared";
import { z } from "zod";
import { attachCommand } from "../adapters/tmuxAdapter.js";
import { isCodexPaneSignal } from "../services/contextCollector.js";
import type { SessionStore } from "../services/sessionStore.js";
import type { PaneSnapshot, TerminalAdapter } from "../types.js";
import { isLoopbackOrigin } from "../utils/origin.js";

const execFileAsync = promisify(execFile);

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdin"), data: z.string() }),
  z.object({ type: z.literal("resize"), data: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }) })
]);

export async function registerWsRoutes(
  app: FastifyInstance,
  deps: {
    adapter: TerminalAdapter;
    store: SessionStore;
    originAllowList: Set<string>;
  }
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

  const resolveRole = (
    activePaneId: string,
    panes: PaneSnapshot[],
    fallback: { currentCommand: string; title: string }
  ): "codex" | "workspace" => {
    const codexCandidates = panes.filter((pane) =>
      isCodexPaneSignal({
        currentCommand: pane.currentCommand,
        title: pane.title
      })
    );
    const codexPane =
      codexCandidates.find((pane) => pane.active || pane.id === activePaneId) ?? codexCandidates[0] ?? null;
    if (codexPane && codexPane.id === activePaneId) {
      return "codex";
    }

    if (
      isCodexPaneSignal({
        currentCommand: fallback.currentCommand,
        title: fallback.title
      })
    ) {
      return "codex";
    }

    return "workspace";
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
    deps.store.ensure(sessionId);
    let probeTargetPromise: Promise<string | null> | null = null;

    const runHiddenEnvironmentProbe = async () => {
      const version = deps.store.nextEnvProbeVersion(sessionId);
      if (version <= 0) {
        return;
      }

      try {
        const probeTarget = (await probeTargetPromise) ?? sessionId;
        const raw = await deps.adapter.probeActiveEnvironment(sessionId, probeTarget);
        let role: "codex" | "workspace" = "workspace";
        try {
          const panes = await deps.adapter.listPanes(sessionId, probeTarget);
          role = resolveRole(raw.activePaneId, panes, {
            currentCommand: raw.paneCurrentCommand,
            title: raw.paneTitle
          });
        } catch {
          role = isCodexPaneSignal({
            currentCommand: raw.paneCurrentCommand,
            title: raw.paneTitle
          })
            ? "codex"
            : "workspace";
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

    term.onData((data) => {
      deps.store.appendStdout(sessionId, data);
      socket.send(JSON.stringify({ type: "stdout", data }));
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
        }
        return;
      }

      term.resize(parsed.data.cols, parsed.data.rows);
    });

    socket.on("close", () => {
      term.kill();
    });
  });
}
