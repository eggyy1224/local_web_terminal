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
const wsParamsSchema = z.object({ sessionId: z.string().min(1) });

interface WsRouteDeps extends ContextSnapshotDeps {
  originAllowList: Set<string>;
}

interface WsPushTiming {
  debounceMs: number;
  heartbeatMs: number;
}

interface WsSocketLike {
  send(payload: string): void;
  close(): void;
  on(event: "message" | "close", listener: (payload?: string | Buffer) => void): void;
}

function getContextPushTiming(): WsPushTiming {
  return {
    debounceMs: Number.parseInt(process.env.CONTEXT_PUSH_DEBOUNCE_MS ?? "300", 10) || 300,
    heartbeatMs: Number.parseInt(process.env.CONTEXT_PUSH_HEARTBEAT_MS ?? "15000", 10) || 15_000
  };
}

function hasSubmitBoundary(data: string): boolean {
  return data.includes("\r") || data.includes("\n");
}

function isAllowedOrigin(origin: string | undefined, allowList: Set<string>): boolean {
  if (!origin) {
    return true;
  }
  return allowList.has(origin) || isLoopbackOrigin(origin);
}

function sendWsEvent(socket: WsSocketLike, type: string, data: unknown): void {
  socket.send(JSON.stringify({ type, data }));
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
  deps: WsRouteDeps
): Promise<void> {
  app.get("/ws/sessions/:sessionId/stream", { websocket: true }, (socket, request) => {
    if (!isAllowedOrigin(request.headers.origin, deps.originAllowList)) {
      sendWsEvent(socket, "error", "origin_not_allowed");
      socket.close();
      return;
    }

    const params = wsParamsSchema.parse(request.params);
    const sessionId = params.sessionId;
    const { debounceMs, heartbeatMs } = getContextPushTiming();
    deps.store.ensure(sessionId);

    const cmd = attachCommand(sessionId);
    const term = pty.spawn(cmd.file, cmd.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 35,
      cwd: process.cwd(),
      env: process.env
    });

    const contextPush = createContextPushCoordinator({
      sessionId,
      socket,
      debounceMs,
      heartbeatMs,
      buildSnapshot: () => buildSessionContextSnapshot(sessionId, deps),
      logger: deps.logger
    });
    const envProbeService = createEnvProbeService({
      sessionId,
      store: deps.store,
      adapter: deps.adapter,
      socket,
      probeTargetPromise: resolveClientTargetByPid(term.pid ?? 0),
      logger: deps.logger
    });

    contextPush.queue("connect", true);
    void envProbeService.runHiddenEnvironmentProbe();

    term.onData((data) => {
      deps.store.appendStdout(sessionId, data);
      sendWsEvent(socket, "stdout", data);
      contextPush.queue("stdout");
    });

    term.onExit(({ exitCode, signal }) => {
      sendWsEvent(socket, "exit", { exitCode, signal });
      socket.close();
    });

    socket.on("message", (raw) => {
      const parsed = decodeWsClientMessage(raw ?? "");
      if (!parsed) {
        sendWsEvent(socket, "error", "invalid_message");
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
