import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerHttpRoutes } from "./routes/httpRoutes.js";
import { SessionStore } from "./services/sessionStore.js";
import type { PaneContext, PaneSnapshot, TerminalAdapter } from "./types.js";

interface AdapterBehavior {
  sessionExists?: boolean;
  paneContext?: PaneContext;
  paneContextError?: boolean;
  panes?: PaneSnapshot[];
  panesError?: boolean;
}

function makeAdapter(behavior: AdapterBehavior = {}): TerminalAdapter {
  return {
    async createSession() {
      return { activePaneId: "%1" };
    },
    async getActivePane() {
      return "%1";
    },
    async getPaneContext() {
      if (behavior.paneContextError) {
        throw new Error("pane_context_failed");
      }
      return behavior.paneContext ?? { cwd: process.cwd(), shell: "zsh" };
    },
    async listPanes() {
      if (behavior.panesError) {
        throw new Error("list_panes_failed");
      }
      return (
        behavior.panes ?? [
          {
            id: "%1",
            index: 0,
            title: "",
            active: true,
            currentPath: process.cwd(),
            currentCommand: "zsh"
          }
        ]
      );
    },
    async ensureSessionExists() {
      return behavior.sessionExists ?? true;
    }
  };
}

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function buildTestApp(adapter: TerminalAdapter, store: SessionStore) {
  const app = Fastify();
  apps.push(app);
  await registerHttpRoutes(app, { adapter, store });
  return app;
}

describe("GET /api/context/:sessionId", () => {
  it("returns required snapshot context fields", async () => {
    const store = new SessionStore();
    const sessionId = "s_ctx_fields";
    store.ensure(sessionId);
    store.appendStdout(sessionId, "all good\nERROR: problem happened\n");
    const adapter = makeAdapter();
    const app = await buildTestApp(adapter, store);

    const response = await app.inject({
      method: "GET",
      url: `/api/context/${sessionId}`
    });

    expect(response.statusCode).toBe(200);
    const parsed = response.json() as Record<string, unknown>;
    expect(typeof parsed.timestamp).toBe("number");
    expect(typeof parsed.cwd).toBe("string");
    expect(typeof parsed.repoRoot).toBe("string");
    expect(typeof parsed.branch).toBe("string");
    expect(typeof parsed.gitStatusPorcelain).toBe("string");
    expect(typeof parsed.diffStat).toBe("string");
    expect(Array.isArray(parsed.recentErrors)).toBe(true);
    expect(Array.isArray(parsed.tmuxPanes)).toBe(true);
  });

  it("keeps endpoint available when pane and pane-list collection fail", async () => {
    const store = new SessionStore();
    const sessionId = "s_ctx_fallback";
    store.ensure(sessionId);
    const adapter = makeAdapter({
      paneContextError: true,
      panesError: true
    });
    const app = await buildTestApp(adapter, store);

    const response = await app.inject({
      method: "GET",
      url: `/api/context/${sessionId}`
    });

    expect(response.statusCode).toBe(200);
    const parsed = response.json() as Record<string, unknown>;
    expect(typeof parsed.cwd).toBe("string");
    expect(typeof parsed.shell).toBe("string");
    expect(parsed.tmuxPanes).toEqual([]);
    expect(typeof parsed.gitStatusPorcelain).toBe("string");
    expect(typeof parsed.diffStat).toBe("string");
  });
});
