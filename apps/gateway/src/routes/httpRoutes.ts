import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SplitDirection } from "@local-terminal/shared";
import type { CommandService } from "../services/commandService.js";
import type { SessionStore } from "../services/sessionStore.js";
import type { TerminalAdapter } from "../types.js";

const createSessionBody = z.object({
  cols: z.number().int().positive().max(1000).default(120),
  rows: z.number().int().positive().max(500).default(35)
});

const splitBody = z.object({
  direction: z.enum(["vertical", "horizontal"]).default("vertical")
});

const proposeBody = z.object({
  sessionId: z.string().min(1),
  command: z.string().min(1)
});

export async function registerHttpRoutes(
  app: FastifyInstance,
  deps: {
    adapter: TerminalAdapter;
    commandService: CommandService;
    store: SessionStore;
  }
): Promise<void> {
  app.get("/api/health", async () => ({ status: "ok", ts: Date.now() }));

  app.post("/api/sessions", async (request, reply) => {
    const body = createSessionBody.parse(request.body ?? {});
    const sessionId = `s_${Date.now().toString(36)}`;
    const created = await deps.adapter.createSession(sessionId, body.cols, body.rows);
    deps.store.ensure(sessionId, created.activePaneId);

    reply.send({
      sessionId,
      activePaneId: created.activePaneId
    });
  });

  app.post("/api/sessions/:sessionId/tabs", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const created = await deps.adapter.createTab(params.sessionId);
    deps.store.ensure(params.sessionId, created.activePaneId);

    reply.send({
      sessionId: params.sessionId,
      activePaneId: created.activePaneId
    });
  });

  app.post("/api/sessions/:sessionId/panes/split", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const body = splitBody.parse(request.body ?? {});
    const split = await deps.adapter.splitPane(params.sessionId, body.direction as SplitDirection);

    reply.send({
      sessionId: params.sessionId,
      paneId: split.paneId,
      direction: body.direction
    });
  });

  app.get("/api/sessions/:sessionId/topology", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const topology = await deps.adapter.listTopology(params.sessionId);
    reply.send(topology);
  });

  app.post("/api/sessions/:sessionId/focus-pane", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const body = z.object({ paneId: z.string().min(1) }).parse(request.body ?? {});
    await deps.adapter.selectPane(params.sessionId, body.paneId);
    const activePane = await deps.adapter.getActivePane(params.sessionId);

    deps.store.setContext(params.sessionId, {
      activePane,
      ...(await deps.adapter.getPaneContext(params.sessionId))
    });

    reply.send({ sessionId: params.sessionId, activePane });
  });

  app.post("/api/commands/propose", async (request, reply) => {
    const body = proposeBody.parse(request.body ?? {});
    const result = deps.commandService.propose(body.sessionId, body.command);
    reply.send(result);
  });

  app.post("/api/commands/:proposalId/confirm", async (request, reply) => {
    const params = z.object({ proposalId: z.string().min(1) }).parse(request.params);

    try {
      const confirmed = await deps.commandService.confirm(params.proposalId);
      reply.send({ proposalId: params.proposalId, executed: true, paneId: confirmed.paneId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      reply.code(400).send({ error: message });
    }
  });

  app.get("/api/context/:sessionId", async (request, reply) => {
    const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const activePane = await deps.adapter.getActivePane(params.sessionId);
    deps.store.ensure(params.sessionId, activePane);
    const paneContext = await deps.adapter.getPaneContext(params.sessionId);

    deps.store.setContext(params.sessionId, {
      activePane,
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
