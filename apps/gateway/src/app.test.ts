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
    async probeActiveEnvironment() {
      return {
        activePaneId: behavior.activePaneId ?? "%1",
        paneCurrentPath: process.cwd(),
        paneCurrentCommand: "zsh",
        paneTitle: "",
        tmux: {
          session: "s_test",
          window: "0",
          pane: "0"
        },
        repoRoot: "",
        isGitRepo: false
      };
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
  it("returns required snapshot context fields with panes payload", async () => {
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
    expect(Array.isArray(parsed.panes)).toBe(true);
    expect(parsed.panes).toHaveLength(2);
    const codingPane = parsed.panes.find((pane) => pane.id === "%1");
    const workspacePane = parsed.panes.find((pane) => pane.id === "%2");
    expect(codingPane?.role).toBe("coding_agent");
    expect(Array.isArray(codingPane?.lines)).toBe(true);
    expect(workspacePane?.role).toBe("workspace");
    expect(Array.isArray(workspacePane?.lines)).toBe(true);
    expect(typeof workspacePane?.repoRoot).toBe("string");
    expect(workspacePane?.gitSnapshot).toBeTruthy();
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
    expect(parsed.panes[0]?.id).toBe("%3");
    expect(parsed.panes[0]?.isActive).toBe(true);
  });

  it("keeps endpoint available when pane and pane-list collection fail", async () => {
    const store = new SessionStore();
    const sessionId = "s_ctx_fallback";
    store.ensure(sessionId);
    store.setLatestPanes(sessionId, [
      {
        id: "%9",
        isActive: false,
        role: "workspace",
        lines: ["cached workspace"],
        cwd: process.cwd(),
        capturedAt: Date.now() - 20_000
      },
      {
        id: "%8",
        isActive: true,
        role: "coding_agent",
        lines: ["cached coding agent"],
        cwd: process.cwd(),
        capturedAt: Date.now() - 20_000
      }
    ]);
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
    expect(parsed.panes).toHaveLength(2);
    expect(parsed.panes.every((pane) => pane.stale)).toBe(true);
    expect(parsed.panes[0]?.id).toBe("%8");
    expect(parsed.recentErrors.some((item) => item.includes("tmux_list_panes_failed"))).toBe(true);
  });

  it("reconciles cached pane activity with latest active pane when pane list fails", async () => {
    const store = new SessionStore();
    const sessionId = "s_ctx_fallback_active_refresh";
    store.ensure(sessionId);
    store.setLatestPanes(sessionId, [
      {
        id: "%9",
        isActive: true,
        role: "workspace",
        lines: ["cached workspace"],
        cwd: process.cwd(),
        capturedAt: Date.now() - 20_000
      },
      {
        id: "%8",
        isActive: false,
        role: "coding_agent",
        lines: ["cached coding agent"],
        cwd: process.cwd(),
        capturedAt: Date.now() - 20_000
      }
    ]);
    const adapter = makeAdapter({
      activePaneId: "%8",
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
    expect(parsed.panes).toHaveLength(2);
    expect(parsed.panes.every((pane) => pane.stale)).toBe(true);
    expect(parsed.panes[0]?.id).toBe("%8");
    expect(parsed.panes[0]?.isActive).toBe(true);
    expect(parsed.panes[1]?.id).toBe("%9");
    expect(parsed.panes[1]?.isActive).toBe(false);
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
    expect(parsed.panes).toHaveLength(2);
    expect(parsed.panes[0]?.lines).toEqual([]);
    expect(parsed.panes[1]?.lines).toEqual([]);
    expect(parsed.panes.every((pane) => pane.stale)).toBe(true);
    expect((parsed.panes[0]?.errors ?? []).some((item) => item.includes("tmux_capture_failed"))).toBe(true);
    expect((parsed.panes[1]?.errors ?? []).some((item) => item.includes("tmux_capture_failed"))).toBe(true);
  });
});

describe("GET /__snapshot.json", () => {
  it("returns panes snapshot for most recent session", async () => {
    const store = new SessionStore();
    const sessionId = "s_sidecar_latest";
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
          currentPath: process.cwd(),
          currentCommand: "zsh"
        }
      ],
      captureLinesByPane: {
        "%1": ["codex recent line"],
        "%2": ["workspace recent line"]
      }
    });
    const app = await buildTestApp(adapter, store);

    const response = await app.inject({
      method: "GET",
      url: "/__snapshot.json"
    });

    expect(response.statusCode).toBe(200);
    const parsed = response.json() as Record<string, unknown>;
    expect(typeof parsed.sessionId).toBe("string");
    expect(typeof parsed.timestamp).toBe("number");
    const panes = parsed.panes as unknown[];
    expect(Array.isArray(panes)).toBe(true);
    expect(panes).toHaveLength(2);
  });

  it("returns 404 when no known session is available", async () => {
    const store = new SessionStore();
    const adapter = makeAdapter();
    const app = await buildTestApp(adapter, store);

    const response = await app.inject({
      method: "GET",
      url: "/__snapshot.json"
    });

    expect(response.statusCode).toBe(404);
  });
});
