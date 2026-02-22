import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pty from "node-pty";
import { SessionStore } from "../services/sessionStore.js";
import { registerWsRoutes } from "./registerWs.js";
import type { PaneContext, PaneSnapshot, TerminalAdapter } from "../types.js";

vi.mock("node-pty", () => ({
  default: {
    spawn: vi.fn()
  }
}));

vi.mock("../adapters/tmuxAdapter.js", () => ({
  attachCommand: vi.fn(() => ({
    file: "tmux",
    args: ["attach-session", "-t", "s_test"]
  }))
}));

interface MockTerm {
  pid: number;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData: (handler: (data: string) => void) => void;
  onExit: (handler: (event: { exitCode: number; signal: number }) => void) => void;
  emitData: (data: string) => void;
}

interface WebSocketLike {
  readyState: number;
  send: (payload: string) => void;
  close: () => void;
  on: (event: string, listener: (payload?: unknown) => void) => void;
}

interface MockRequest {
  headers: {
    origin?: string;
  };
  params: {
    sessionId: string;
  };
}

class FakeSocket implements WebSocketLike {
  readyState = 1;
  closed = false;
  sent: string[] = [];
  private readonly listeners = new Map<string, Array<(payload?: unknown) => void>>();

  send(payload: string): void {
    this.sent.push(String(payload));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  on(event: string, listener: (payload?: unknown) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  emit(event: string, payload?: unknown): void {
    const listeners = this.listeners.get(event) ?? [];
    for (const listener of listeners) {
      listener(payload);
    }
  }
}

class FakeApp {
  wsHandler: ((socket: WebSocketLike, request: MockRequest) => void) | null = null;

  get(
    _path: string,
    _opts: { websocket: true },
    handler: (socket: WebSocketLike, request: MockRequest) => void
  ): void {
    this.wsHandler = handler;
  }
}

function createAdapter(overrides: Partial<TerminalAdapter> = {}): TerminalAdapter {
  const defaults: TerminalAdapter = {
    createSession: async () => ({ activePaneId: "%1" }),
    getActivePane: async () => "%1",
    getPaneContext: async () => ({ cwd: process.cwd(), shell: "zsh" } satisfies PaneContext),
    probeActiveEnvironment: async () => ({
      activePaneId: "%1",
      paneCurrentPath: process.cwd(),
      paneCurrentCommand: "zsh",
      paneTitle: "",
      tmux: {
        session: "s_test",
        window: "0",
        pane: "1"
      },
      repoRoot: "",
      isGitRepo: false
    }),
    listPanes: async () =>
      [
        {
          id: "%1",
          index: 0,
          title: "workspace",
          active: true,
          currentPath: process.cwd(),
          currentCommand: "zsh"
        }
      ] satisfies PaneSnapshot[],
    capturePaneLines: async () => [],
    ensureSessionExists: async () => true
  };

  return {
    ...defaults,
    ...overrides
  };
}

function createMockTerm(): MockTerm {
  let onDataHandler: ((data: string) => void) | null = null;
  return {
    pid: 0,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData(handler) {
      onDataHandler = handler;
    },
    onExit(_handler) {
      // noop for tests that only exercise streaming input/output path.
    },
    emitData(data: string) {
      onDataHandler?.(data);
    }
  };
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 1_500, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("wait_for_timeout");
}

describe("registerWsRoutes", () => {
  const originalDebounce = process.env.CONTEXT_PUSH_DEBOUNCE_MS;
  const originalHeartbeat = process.env.CONTEXT_PUSH_HEARTBEAT_MS;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalDebounce === undefined) {
      delete process.env.CONTEXT_PUSH_DEBOUNCE_MS;
    } else {
      process.env.CONTEXT_PUSH_DEBOUNCE_MS = originalDebounce;
    }

    if (originalHeartbeat === undefined) {
      delete process.env.CONTEXT_PUSH_HEARTBEAT_MS;
    } else {
      process.env.CONTEXT_PUSH_HEARTBEAT_MS = originalHeartbeat;
    }
  });

  it("rejects non-loopback origin not in allow list", async () => {
    const app = new FakeApp();
    const store = new SessionStore();
    const spawnMock = vi.mocked(pty.spawn);
    const term = createMockTerm();
    spawnMock.mockReturnValue(term as never);

    await registerWsRoutes(app as never, {
      adapter: createAdapter(),
      store,
      originAllowList: new Set(["http://127.0.0.1:5173"])
    });

    const socket = new FakeSocket();
    app.wsHandler?.(socket, {
      headers: { origin: "https://evil.example" },
      params: { sessionId: "s_ws_reject" }
    });

    expect(spawnMock).not.toHaveBeenCalled();
    const messages = socket.sent.map((raw) => JSON.parse(raw) as { type: string; data: string });
    expect(messages).toContainEqual({ type: "error", data: "origin_not_allowed" });
    expect(socket.closed).toBe(true);
  });

  it("emits invalid_message for malformed websocket payload", async () => {
    const app = new FakeApp();
    const store = new SessionStore();
    const spawnMock = vi.mocked(pty.spawn);
    const term = createMockTerm();
    spawnMock.mockReturnValue(term as never);

    await registerWsRoutes(app as never, {
      adapter: createAdapter(),
      store,
      originAllowList: new Set()
    });

    const socket = new FakeSocket();
    app.wsHandler?.(socket, {
      headers: {},
      params: { sessionId: "s_ws_invalid" }
    });
    socket.emit("message", "{not-json");

    const messages = socket.sent.map((raw) => JSON.parse(raw) as { type: string; data: string });
    expect(messages).toContainEqual({ type: "error", data: "invalid_message" });
  });

  it("pushes context snapshot immediately on connect", async () => {
    const app = new FakeApp();
    const store = new SessionStore();
    const spawnMock = vi.mocked(pty.spawn);
    const term = createMockTerm();
    spawnMock.mockReturnValue(term as never);

    await registerWsRoutes(app as never, {
      adapter: createAdapter(),
      store,
      originAllowList: new Set()
    });

    const socket = new FakeSocket();
    app.wsHandler?.(socket, {
      headers: {},
      params: { sessionId: "s_ws_connect_push" }
    });

    await waitFor(
      () =>
        socket.sent.some((raw) => {
          const parsed = JSON.parse(raw) as { type: string; data?: { kind?: string; reason?: string } };
          return parsed.type === "meta" && parsed.data?.kind === "context_snapshot" && parsed.data?.reason === "connect";
        }),
      { timeoutMs: 10_000 }
    );

    const meta = socket.sent
      .map(
        (raw) =>
          JSON.parse(raw) as {
            type: string;
            data?: { kind?: string; reason?: string; snapshot?: { sessionId?: string } };
          }
      )
      .find((item) => item.type === "meta" && item.data?.kind === "context_snapshot");
    expect(meta?.data?.snapshot?.sessionId).toBe("s_ws_connect_push");
  }, 15_000);

  it("emits env_probe meta on connect without waiting for submit", async () => {
    const app = new FakeApp();
    const store = new SessionStore();
    const spawnMock = vi.mocked(pty.spawn);
    const term = createMockTerm();
    spawnMock.mockReturnValue(term as never);

    const probeActiveEnvironment = vi.fn(async () => ({
      activePaneId: "%1",
      paneCurrentPath: process.cwd(),
      paneCurrentCommand: "zsh",
      paneTitle: "",
      tmux: {
        session: "s_test",
        window: "0",
        pane: "1"
      },
      repoRoot: process.cwd(),
      isGitRepo: true
    }));

    await registerWsRoutes(app as never, {
      adapter: createAdapter({ probeActiveEnvironment }),
      store,
      originAllowList: new Set()
    });

    const socket = new FakeSocket();
    const sessionId = "s_ws_connect_env_probe";
    app.wsHandler?.(socket, {
      headers: {},
      params: { sessionId }
    });

    await waitFor(
      () =>
        socket.sent.some((raw) => {
          const parsed = JSON.parse(raw) as { type: string; data?: { kind?: string } };
          return parsed.type === "meta" && parsed.data?.kind === "env_probe";
        }),
      { timeoutMs: 10_000 }
    );

    expect(probeActiveEnvironment).toHaveBeenCalledWith(sessionId, sessionId);
  });

  it("coalesces stdout burst into a bounded number of context pushes", async () => {
    process.env.CONTEXT_PUSH_DEBOUNCE_MS = "40";
    process.env.CONTEXT_PUSH_HEARTBEAT_MS = "100000";
    const app = new FakeApp();
    const store = new SessionStore();
    const spawnMock = vi.mocked(pty.spawn);
    const term = createMockTerm();
    spawnMock.mockReturnValue(term as never);

    await registerWsRoutes(app as never, {
      adapter: createAdapter(),
      store,
      originAllowList: new Set()
    });

    const socket = new FakeSocket();
    app.wsHandler?.(socket, {
      headers: {},
      params: { sessionId: "s_ws_stdout_burst" }
    });

    await waitFor(
      () =>
        socket.sent.some((raw) => {
          const parsed = JSON.parse(raw) as { type: string; data?: { kind?: string; reason?: string } };
          return parsed.type === "meta" && parsed.data?.kind === "context_snapshot" && parsed.data?.reason === "connect";
        }),
      { timeoutMs: 10_000 }
    );

    term.emitData("line-1\n");
    term.emitData("line-2\n");
    term.emitData("line-3\n");

    await waitFor(
      () =>
        socket.sent.filter((raw) => {
          const parsed = JSON.parse(raw) as { type: string; data?: { kind?: string; reason?: string } };
          return parsed.type === "meta" && parsed.data?.kind === "context_snapshot";
        }).length >= 2,
      { timeoutMs: 5_000 }
    );

    const contextSnapshots = socket.sent.filter((raw) => {
      const parsed = JSON.parse(raw) as { type: string; data?: { kind?: string } };
      return parsed.type === "meta" && parsed.data?.kind === "context_snapshot";
    });
    expect(contextSnapshots).toHaveLength(2);
  }, 15_000);

  it("handles stdin/resize and emits env_probe meta after submit", async () => {
    const app = new FakeApp();
    const store = new SessionStore();
    const spawnMock = vi.mocked(pty.spawn);
    const term = createMockTerm();
    spawnMock.mockReturnValue(term as never);

    const probeActiveEnvironment = vi.fn(async () => ({
      activePaneId: "%1",
      paneCurrentPath: process.cwd(),
      paneCurrentCommand: "zsh",
      paneTitle: "workspace",
      tmux: {
        session: "s_test",
        window: "0",
        pane: "1"
      },
      repoRoot: process.cwd(),
      isGitRepo: true
    }));

    await registerWsRoutes(app as never, {
      adapter: createAdapter({ probeActiveEnvironment }),
      store,
      originAllowList: new Set()
    });

    const socket = new FakeSocket();
    const sessionId = "s_ws_stream";
    app.wsHandler?.(socket, {
      headers: {},
      params: { sessionId }
    });

    term.emitData("hello from pty\n");
    socket.emit("message", JSON.stringify({ type: "resize", data: { cols: 120, rows: 40 } }));
    socket.emit("message", JSON.stringify({ type: "stdin", data: "echo test\r" }));

    expect(term.resize).toHaveBeenCalledWith(120, 40);
    expect(term.write).toHaveBeenCalledWith("echo test\r");

    await waitFor(() => probeActiveEnvironment.mock.calls.length > 0);
    expect(probeActiveEnvironment).toHaveBeenCalledWith(sessionId, sessionId);

    await waitFor(() =>
      socket.sent.some((raw) => {
        const parsed = JSON.parse(raw) as { type: string; data?: { kind?: string } };
        return parsed.type === "meta" && parsed.data?.kind === "env_probe";
      })
    );

    const context = store.getContext(sessionId);
    expect(context?.lastCommands).toContain("echo test");
    expect(socket.sent.some((raw) => JSON.parse(raw).type === "stdout")).toBe(true);
  });

  it("classifies active repo pane with non-shell command as workspace", async () => {
    const app = new FakeApp();
    const store = new SessionStore();
    const spawnMock = vi.mocked(pty.spawn);
    const term = createMockTerm();
    spawnMock.mockReturnValue(term as never);

    const probeActiveEnvironment = vi.fn(async () => ({
      activePaneId: "%1",
      paneCurrentPath: process.cwd(),
      paneCurrentCommand: "npm",
      paneTitle: "",
      tmux: {
        session: "s_test",
        window: "0",
        pane: "1"
      },
      repoRoot: process.cwd(),
      isGitRepo: true
    }));

    const listPanes = vi.fn(async () =>
      [
        {
          id: "%1",
          index: 0,
          title: "",
          active: true,
          currentPath: process.cwd(),
          currentCommand: "npm"
        }
      ] satisfies PaneSnapshot[]
    );

    await registerWsRoutes(app as never, {
      adapter: createAdapter({ probeActiveEnvironment, listPanes }),
      store,
      originAllowList: new Set()
    });

    const socket = new FakeSocket();
    app.wsHandler?.(socket, {
      headers: {},
      params: { sessionId: "s_ws_role_workspace" }
    });

    socket.emit("message", JSON.stringify({ type: "stdin", data: "echo test\r" }));

    await waitFor(() =>
      socket.sent.some((raw) => {
        const parsed = JSON.parse(raw) as { type: string; data?: { kind?: string } };
        return parsed.type === "meta" && parsed.data?.kind === "env_probe";
      })
    );

    const meta = socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; data?: { kind?: string; env?: { role?: string } } })
      .find((item) => item.type === "meta" && item.data?.kind === "env_probe");
    expect(meta?.data?.env?.role).toBe("workspace");
  });

  it("prefers activePaneId over pane.active when inferring role", async () => {
    const app = new FakeApp();
    const store = new SessionStore();
    const spawnMock = vi.mocked(pty.spawn);
    const term = createMockTerm();
    spawnMock.mockReturnValue(term as never);

    const probeActiveEnvironment = vi.fn(async () => ({
      activePaneId: "%2",
      paneCurrentPath: process.cwd(),
      paneCurrentCommand: "codex",
      paneTitle: "",
      tmux: {
        session: "s_test",
        window: "0",
        pane: "2"
      },
      repoRoot: process.cwd(),
      isGitRepo: true
    }));

    const listPanes = vi.fn(async () =>
      [
        {
          id: "%1",
          index: 0,
          title: "workspace",
          active: true,
          currentPath: process.cwd(),
          currentCommand: "zsh"
        },
        {
          id: "%2",
          index: 1,
          title: "codex",
          active: false,
          currentPath: process.cwd(),
          currentCommand: "codex"
        }
      ] satisfies PaneSnapshot[]
    );

    await registerWsRoutes(app as never, {
      adapter: createAdapter({ probeActiveEnvironment, listPanes }),
      store,
      originAllowList: new Set()
    });

    const socket = new FakeSocket();
    app.wsHandler?.(socket, {
      headers: {},
      params: { sessionId: "s_ws_role_prefers_active_pane_id" }
    });

    socket.emit("message", JSON.stringify({ type: "stdin", data: "echo test\r" }));

    await waitFor(() =>
      socket.sent.some((raw) => {
        const parsed = JSON.parse(raw) as { type: string; data?: { kind?: string } };
        return parsed.type === "meta" && parsed.data?.kind === "env_probe";
      })
    );

    const meta = socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; data?: { kind?: string; env?: { role?: string } } })
      .find((item) => item.type === "meta" && item.data?.kind === "env_probe");
    expect(meta?.data?.env?.role).toBe("coding_agent");
  });

  it("uses probe fallback when activePaneId is missing from pane list", async () => {
    const app = new FakeApp();
    const store = new SessionStore();
    const spawnMock = vi.mocked(pty.spawn);
    const term = createMockTerm();
    spawnMock.mockReturnValue(term as never);

    const probeActiveEnvironment = vi.fn(async () => ({
      activePaneId: "%2",
      paneCurrentPath: process.cwd(),
      paneCurrentCommand: "codex",
      paneTitle: "",
      tmux: {
        session: "s_test",
        window: "0",
        pane: "2"
      },
      repoRoot: process.cwd(),
      isGitRepo: true
    }));

    const listPanes = vi.fn(async () =>
      [
        {
          id: "%1",
          index: 0,
          title: "workspace",
          active: true,
          currentPath: process.cwd(),
          currentCommand: "zsh"
        }
      ] satisfies PaneSnapshot[]
    );

    await registerWsRoutes(app as never, {
      adapter: createAdapter({ probeActiveEnvironment, listPanes }),
      store,
      originAllowList: new Set()
    });

    const socket = new FakeSocket();
    app.wsHandler?.(socket, {
      headers: {},
      params: { sessionId: "s_ws_role_missing_active_pane" }
    });

    socket.emit("message", JSON.stringify({ type: "stdin", data: "echo test\r" }));

    await waitFor(() =>
      socket.sent.some((raw) => {
        const parsed = JSON.parse(raw) as { type: string; data?: { kind?: string } };
        return parsed.type === "meta" && parsed.data?.kind === "env_probe";
      })
    );

    const meta = socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; data?: { kind?: string; env?: { role?: string } } })
      .find((item) => item.type === "meta" && item.data?.kind === "env_probe");
    expect(meta?.data?.env?.role).toBe("coding_agent");
  });

  it("kills pty when websocket closes", async () => {
    const app = new FakeApp();
    const store = new SessionStore();
    const spawnMock = vi.mocked(pty.spawn);
    const term = createMockTerm();
    spawnMock.mockReturnValue(term as never);

    await registerWsRoutes(app as never, {
      adapter: createAdapter(),
      store,
      originAllowList: new Set()
    });

    const socket = new FakeSocket();
    app.wsHandler?.(socket, {
      headers: {},
      params: { sessionId: "s_ws_close" }
    });

    socket.close();
    expect(term.kill).toHaveBeenCalledTimes(1);
    expect(store.getContext("s_ws_close")).toBeTruthy();
  });

  it("stops heartbeat-driven pushes after websocket closes", async () => {
    process.env.CONTEXT_PUSH_DEBOUNCE_MS = "10";
    process.env.CONTEXT_PUSH_HEARTBEAT_MS = "40";
    const app = new FakeApp();
    const store = new SessionStore();
    const spawnMock = vi.mocked(pty.spawn);
    const term = createMockTerm();
    spawnMock.mockReturnValue(term as never);
    const ensureSessionExists = vi.fn(async () => true);

    await registerWsRoutes(app as never, {
      adapter: createAdapter({ ensureSessionExists }),
      store,
      originAllowList: new Set()
    });

    const socket = new FakeSocket();
    app.wsHandler?.(socket, {
      headers: {},
      params: { sessionId: "s_ws_close_heartbeat" }
    });

    await waitFor(
      () =>
        socket.sent.some((raw) => {
          const parsed = JSON.parse(raw) as { type: string; data?: { kind?: string; reason?: string } };
          return parsed.type === "meta" && parsed.data?.kind === "context_snapshot" && parsed.data?.reason === "connect";
        }),
      { timeoutMs: 10_000 }
    );

    await new Promise((resolve) => setTimeout(resolve, 65));
    const callsBeforeClose = ensureSessionExists.mock.calls.length;
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(ensureSessionExists.mock.calls.length).toBe(callsBeforeClose);
  }, 15_000);
});
