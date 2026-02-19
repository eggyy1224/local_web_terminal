import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { LOCAL_ORIGIN_DEFAULT } from "@local-terminal/shared";
import { TmuxAdapter } from "./adapters/tmuxAdapter.js";
import { registerHttpRoutes } from "./routes/httpRoutes.js";
import { SessionStore } from "./services/sessionStore.js";
import { isLoopbackOrigin } from "./utils/origin.js";
import { createAppLogger } from "./utils/logger.js";
import { registerWsRoutes } from "./ws/registerWs.js";

function parseOrigins(raw = process.env.ORIGIN_WHITELIST ?? LOCAL_ORIGIN_DEFAULT): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

export async function buildApp() {
  const app = Fastify({ logger: true });
  const originAllowList = parseOrigins();

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true);
        return;
      }

      if (originAllowList.has(origin)) {
        cb(null, true);
        return;
      }

      if (isLoopbackOrigin(origin)) {
        cb(null, true);
        return;
      }

      cb(new Error("origin_not_allowed"), false);
    },
    methods: ["GET", "POST", "OPTIONS"]
  });

  await app.register(websocket);

  const adapter = new TmuxAdapter();
  const store = new SessionStore();
  const logger = createAppLogger(app.log);
  const sessionPruneIntervalMs = Number.parseInt(process.env.SESSION_PRUNE_INTERVAL_MS ?? "60000", 10) || 60_000;
  const pruneTimer = setInterval(() => {
    const removed = store.pruneExpiredSessions();
    if (removed.length > 0) {
      logger.warn({
        code: "session_pruned",
        details: {
          count: removed.length,
          sessionIds: removed
        }
      });
    }
  }, sessionPruneIntervalMs);
  pruneTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(pruneTimer);
  });

  await registerHttpRoutes(app, { adapter, store, logger });
  await registerWsRoutes(app, { adapter, store, logger, originAllowList });

  return app;
}
