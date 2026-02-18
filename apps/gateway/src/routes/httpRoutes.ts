import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SessionStore } from "../services/sessionStore.js";
import type { TerminalAdapter } from "../types.js";

const createSessionBody = z.object({
  cols: z.number().int().positive().max(1000).default(120),
  rows: z.number().int().positive().max(500).default(35)
});

export async function registerHttpRoutes(
  app: FastifyInstance,
  deps: {
    adapter: TerminalAdapter;
    store: SessionStore;
  }
): Promise<void> {
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
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);

    const exists = await deps.adapter.ensureSessionExists(params.sessionId);
    if (!exists) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }

    deps.store.ensure(params.sessionId);
    const paneContext = await deps.adapter.getPaneContext(params.sessionId);

    deps.store.setContext(params.sessionId, {
      cwd: paneContext.cwd,
      shell: paneContext.shell
    });

    const context = deps.store.getContext(params.sessionId);
    if (!context) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }

    reply.send(context);
  });
}
