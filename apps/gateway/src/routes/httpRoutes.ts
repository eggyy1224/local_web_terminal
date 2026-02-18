import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collectGitSnapshot } from "../services/contextCollector.js";
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

    let paneCwd: string | null = null;
    let paneShell: string | null = null;
    try {
      const paneContext = await deps.adapter.getPaneContext(params.sessionId);
      paneCwd = paneContext.cwd || null;
      paneShell = paneContext.shell || null;
      deps.store.setContext(params.sessionId, {
        cwd: paneContext.cwd || process.cwd(),
        shell: paneContext.shell || ""
      });
    } catch {
      // Keep context endpoint available even when tmux context lookup fails.
    }

    const context = deps.store.getContext(params.sessionId);
    if (!context) {
      reply.code(404).send({ error: "session_not_found" });
      return;
    }

    const cwd = paneCwd ?? context.cwd ?? process.cwd();
    const shell = paneShell ?? context.shell ?? "";
    const [gitSnapshot, tmuxPanes] = await Promise.all([
      collectGitSnapshot(cwd),
      deps.adapter.listPanes(params.sessionId).catch(() => [])
    ]);

    reply.send({
      ...context,
      timestamp: Date.now(),
      cwd,
      shell,
      repoRoot: gitSnapshot.repoRoot,
      branch: gitSnapshot.branch,
      gitStatusPorcelain: gitSnapshot.gitStatusPorcelain,
      diffStat: gitSnapshot.diffStat,
      tmuxPanes
    });
  });
}
