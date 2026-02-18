import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { LOCAL_ORIGIN_DEFAULT } from "@local-terminal/shared";
import { TmuxAdapter } from "./adapters/tmuxAdapter.js";
import { registerHttpRoutes } from "./routes/httpRoutes.js";
import { SessionStore } from "./services/sessionStore.js";
import { isLoopbackOrigin } from "./utils/origin.js";
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

  await registerHttpRoutes(app, { adapter, store });
  await registerWsRoutes(app, { store, originAllowList });

  return app;
}
