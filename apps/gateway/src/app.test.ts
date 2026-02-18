import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionContext } from "@local-terminal/shared";
import { registerHttpRoutes } from "./routes/httpRoutes.js";
import { SessionStore } from "./services/sessionStore.js";
import type { PaneContext, PaneSnapshot, TerminalAdapter } from "./types.js";

interface AdapterBehavior {
  sessionExists?: boolean;
  activePaneId?: string;
  activePaneError?: boolean;
  paneContext?: PaneContext;
  paneContextError?: boolean;
  panes?: PaneSnapshot[];
  panesError?: boolean;
  captureLinesByPane?: Record<string, string[]>;
  captureErrorPaneIds?: string[];
}

function makeAdapter(behavior: AdapterBehavior = {}): TerminalAdapter {
  return {
    async createSession() {
      return { activePaneId: "%1" };
    },
    async getActivePane() {
      if (behavior.activePaneError) {
        throw new Error("active_pane_failed");
      }
      if (behavior.activePaneId) {
        return behavior.activePaneId;
      }
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
    async capturePaneLines(_, paneId) {
      if (behavior.captureErrorPaneIds?.includes(paneId)) {
        throw new Error("capture_failed");
      }
      return behavior.captureLinesByPane?.[paneId] ?? ["line-one"];
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
  it("returns required snapshot context fields with twoPane payload", async () => {
    const store = new SessionStore();
    const sessionId = "s_ctx_fields";
    store.ensure(sessionId);
    store.appendStdout(sessionId, "all good\nERROR: problem happened\n");
    const adapter = makeAdapter({
      activePaneId: "%1",
      panes: [
        {
          id: "%1",
          index: 0,
          title: "codex",
          active: true,
          currentPath: process.cwd(),
          currentCommand: "codex"
        },
        {
          id: "%2",
          index: 1,
          title: "workspace",
          active: false,
          currentPath: process.cwd(),
          currentCommand: "zsh"
        }
      ],
      captureLinesByPane: {
        "%1": ["codex output"],
        "%2": ["workspace output"]
      }
    });
    const app = await buildTestApp(adapter, store);

    const response = await app.inject({
      method: "GET",
      url: `/api/context/${sessionId}`
    });

    expect(response.statusCode).toBe(200);
    const parsed = response.json() as SessionContext;
    expect(typeof parsed.timestamp).toBe("number");
    expect(typeof parsed.cwd).toBe("string");
    expect(typeof parsed.repoRoot).toBe("string");
    expect(typeof parsed.branch).toBe("string");
    expect(typeof parsed.gitStatusPorcelain).toBe("string");
    expect(typeof parsed.diffStat).toBe("string");
    expect(Array.isArray(parsed.recentErrors)).toBe(true);
    expect(Array.isArray(parsed.tmuxPanes)).toBe(true);
    const twoPane = parsed.twoPane;
    expect(typeof twoPane.activePaneId).toBe("string");
    expect(twoPane.codex.role).toBe("codex");
    expect(Array.isArray(twoPane.codex.lines)).toBe(true);
    expect(twoPane.codex.id).toBe("%1");
    expect(twoPane.workspace.role).toBe("workspace");
    expect(Array.isArray(twoPane.workspace.lines)).toBe(true);
    expect(twoPane.workspace.id).toBe("%2");
    expect(typeof twoPane.workspace.repoRoot).toBe("string");
    expect(twoPane.workspace.gitSnapshot).toBeTruthy();
  });

  it("prefers active repo workspace pane when multiple repo candidates exist", async () => {
    const store = new SessionStore();
    const sessionId = "s_workspace_pick";
    store.ensure(sessionId);
    const adapter = makeAdapter({
      activePaneId: "%3",
      panes: [
        {
          id: "%1",
          index: 0,
          title: "codex",
          active: false,
          currentPath: process.cwd(),
          currentCommand: "codex"
        },
        {
          id: "%2",
          index: 1,
          title: "workspace-a",
          active: false,
          currentPath: process.cwd(),
          currentCommand: "zsh"
        },
        {
          id: "%3",
          index: 2,
          title: "workspace-b",
          active: true,
          currentPath: process.cwd(),
          currentCommand: "zsh"
        }
      ],
      captureLinesByPane: {
        "%1": ["codex output"],
        "%2": ["workspace A"],
        "%3": ["workspace B"]
      }
    });
    const app = await buildTestApp(adapter, store);

    const response = await app.inject({
      method: "GET",
      url: `/api/context/${sessionId}`
    });

    expect(response.statusCode).toBe(200);
    const parsed = response.json() as SessionContext;
    expect(parsed.twoPane.workspace.id).toBe("%3");
    expect(parsed.twoPane.workspace.isActive).toBe(true);
  });

  it("keeps endpoint available when pane and pane-list collection fail", async () => {
    const store = new SessionStore();
    const sessionId = "s_ctx_fallback";
    store.ensure(sessionId);
    const adapter = makeAdapter({
      activePaneError: true,
      paneContextError: true,
      panesError: true
    });
    const app = await buildTestApp(adapter, store);

    const response = await app.inject({
      method: "GET",
      url: `/api/context/${sessionId}`
    });

    expect(response.statusCode).toBe(200);
    const parsed = response.json() as SessionContext;
    expect(typeof parsed.cwd).toBe("string");
    expect(typeof parsed.shell).toBe("string");
    expect(parsed.tmuxPanes).toEqual([]);
    expect(typeof parsed.gitStatusPorcelain).toBe("string");
    expect(typeof parsed.diffStat).toBe("string");
    expect(Array.isArray(parsed.twoPane.codex.lines)).toBe(true);
    expect(Array.isArray(parsed.twoPane.workspace.lines)).toBe(true);
    expect(parsed.twoPane.codex.lines).toEqual([]);
    expect(parsed.twoPane.workspace.lines).toEqual([]);
    expect((parsed.twoPane.codex.errors ?? []).length).toBeGreaterThan(0);
    expect((parsed.twoPane.workspace.errors ?? []).length).toBeGreaterThan(0);
    expect(parsed.recentErrors.some((item) => item.includes("tmux_list_panes_failed"))).toBe(true);
  });

  it("returns pane-level errors when line capture fails", async () => {
    const store = new SessionStore();
    const sessionId = "s_ctx_capture_fallback";
    store.ensure(sessionId);
    const adapter = makeAdapter({
      panes: [
        {
          id: "%1",
          index: 0,
          title: "codex",
          active: true,
          currentPath: process.cwd(),
          currentCommand: "codex"
        },
        {
          id: "%2",
          index: 1,
          title: "workspace",
          active: false,
          currentPath: "/tmp",
          currentCommand: "zsh"
        }
      ],
      captureErrorPaneIds: ["%1", "%2"]
    });
    const app = await buildTestApp(adapter, store);

    const response = await app.inject({
      method: "GET",
      url: `/api/context/${sessionId}`
    });

    expect(response.statusCode).toBe(200);
    const parsed = response.json() as SessionContext;
    expect(parsed.twoPane.codex.lines).toEqual([]);
    expect(parsed.twoPane.workspace.lines).toEqual([]);
    expect((parsed.twoPane.codex.errors ?? []).some((item) => item.includes("tmux_capture_failed"))).toBe(true);
    expect((parsed.twoPane.workspace.errors ?? []).some((item) => item.includes("tmux_capture_failed"))).toBe(
      true
    );
  });
});
