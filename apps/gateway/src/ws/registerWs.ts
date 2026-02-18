import type { FastifyInstance } from "fastify";
import pty from "node-pty";
import { z } from "zod";
import { attachCommand } from "../adapters/tmuxAdapter.js";
import type { SessionStore, } from "../services/sessionStore.js";
import { isLoopbackOrigin } from "../utils/origin.js";
import type { TerminalAdapter } from "../types.js";

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdin"), data: z.string() }),
  z.object({ type: z.literal("resize"), data: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }) }),
  z.object({ type: z.literal("focus-pane"), data: z.object({ paneId: z.string().min(1) }) })
]);

export async function registerWsRoutes(
  app: FastifyInstance,
  deps: {
    adapter: TerminalAdapter;
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
    void deps.adapter.getActivePane(sessionId).then(
      (activePane) => deps.store.ensure(sessionId, activePane),
      () => deps.store.ensure(sessionId, "")
    );

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

    socket.on("message", async (raw: string | Buffer) => {
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

      if (parsed.type === "resize") {
        term.resize(parsed.data.cols, parsed.data.rows);
        return;
      }

      if (parsed.type === "focus-pane") {
        await deps.adapter.selectPane(sessionId, parsed.data.paneId);
        socket.send(JSON.stringify({ type: "pane-meta", data: { activePane: parsed.data.paneId } }));
      }
    });

    socket.on("close", () => {
      term.kill();
    });
  });
}
