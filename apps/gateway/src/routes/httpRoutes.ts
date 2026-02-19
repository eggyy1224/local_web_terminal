import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildSessionContextSnapshot, type ContextSnapshotDeps } from "../services/contextSnapshot.js";

const createSessionBody = z.object({
  cols: z.number().int().positive().max(1000).default(120),
  rows: z.number().int().positive().max(500).default(35)
});

const snapshotQuerySchema = z.object({
  sessionId: z.string().min(1).optional()
});

const contextParamsSchema = z.object({ sessionId: z.string().min(1) });

type RouteDeps = ContextSnapshotDeps;

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
