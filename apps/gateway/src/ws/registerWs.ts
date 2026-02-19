import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pty from "node-pty";
import { z } from "zod";
import { attachCommand } from "../adapters/tmuxAdapter.js";
import { buildSessionContextSnapshot, type ContextSnapshotDeps } from "../services/contextSnapshot.js";
import { isLoopbackOrigin } from "../utils/origin.js";
import { createContextPushCoordinator } from "./contextPushCoordinator.js";
import { createEnvProbeService } from "./envProbeService.js";
import { decodeWsClientMessage } from "./wsMessageCodec.js";

const execFileAsync = promisify(execFile);

function hasSubmitBoundary(data: string): boolean {
  return data.includes("\r") || data.includes("\n");
}

async function resolveClientTargetByPid(pid: number): Promise<string | null> {
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
}

export async function registerWsRoutes(
  app: FastifyInstance,
  deps: ContextSnapshotDeps & { originAllowList: Set<string> }
): Promise<void> {
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

    const cmd = attachCommand(sessionId);
    const term = pty.spawn(cmd.file, cmd.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 35,
      cwd: process.cwd(),
      env: process.env
    });
    const probeTargetPromise = resolveClientTargetByPid(term.pid ?? 0);
    const contextPush = createContextPushCoordinator({
      sessionId,
      socket,
      debounceMs: contextPushDebounceMs,
      heartbeatMs: contextPushHeartbeatMs,
      buildSnapshot: () => buildSessionContextSnapshot(sessionId, deps),
      logger: deps.logger
    });
    const envProbeService = createEnvProbeService({
      sessionId,
      store: deps.store,
      adapter: deps.adapter,
      socket,
      probeTargetPromise,
      logger: deps.logger
    });
    contextPush.queue("connect", true);

    term.onData((data) => {
      deps.store.appendStdout(sessionId, data);
      socket.send(JSON.stringify({ type: "stdout", data }));
      contextPush.queue("stdout");
    });

    term.onExit(({ exitCode, signal }) => {
      socket.send(JSON.stringify({ type: "exit", data: { exitCode, signal } }));
      socket.close();
    });

    socket.on("message", (raw: string | Buffer) => {
      const parsed = decodeWsClientMessage(raw);
      if (!parsed) {
        socket.send(JSON.stringify({ type: "error", data: "invalid_message" }));
        return;
      }

      if (parsed.type === "stdin") {
        deps.store.appendInput(sessionId, parsed.data);
        term.write(parsed.data);
        if (hasSubmitBoundary(parsed.data)) {
          void envProbeService.runHiddenEnvironmentProbe();
          contextPush.queue("submit", true);
        }
        return;
      }

      term.resize(parsed.data.cols, parsed.data.rows);
      contextPush.queue("resize");
    });

    socket.on("close", () => {
      contextPush.dispose();
      term.kill();
    });
  });
}
