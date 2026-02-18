import type { FastifyInstance } from "fastify";
import pty from "node-pty";
import { z } from "zod";
import { attachCommand } from "../adapters/tmuxAdapter.js";
import type { SessionStore } from "../services/sessionStore.js";
import { isLoopbackOrigin } from "../utils/origin.js";

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdin"), data: z.string() }),
  z.object({ type: z.literal("resize"), data: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }) })
]);

export async function registerWsRoutes(
  app: FastifyInstance,
  deps: {
    store: SessionStore;
    originAllowList: Set<string>;
  }
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
    deps.store.ensure(sessionId);

    const cmd = attachCommand(sessionId);
    const term = pty.spawn(cmd.file, cmd.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 35,
      cwd: process.cwd(),
      env: process.env
    });

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
        return;
      }

      term.resize(parsed.data.cols, parsed.data.rows);
    });

    socket.on("close", () => {
      term.kill();
    });
  });
}
