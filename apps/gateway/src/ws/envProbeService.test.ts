import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../services/sessionStore.js";
import { createEnvProbeService } from "./envProbeService.js";
import type { PaneContext, PaneSnapshot, TerminalAdapter } from "../types.js";

class FakeSocket {
  readyState = 1;
  sent: string[] = [];

  send(payload: string): void {
    this.sent.push(payload);
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
      paneTitle: "workspace",
      tmux: {
        session: "s_test",
        window: "1",
        pane: "1"
      },
      repoRoot: process.cwd(),
      isGitRepo: true
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

describe("createEnvProbeService", () => {
  it("does not emit env_probe from stale candidate when tmux identity check fails", async () => {
    const sessionId = "s_env_probe_stale_guard";
    const store = new SessionStore();
    store.ensure(sessionId);
    const socket = new FakeSocket();
    const warn = vi.fn();
    const probeActiveEnvironment = vi.fn(async (_sessionId: string, target?: string) => {
      if (target === "/dev/ttys999") {
        return {
          activePaneId: "",
          paneCurrentPath: process.cwd(),
          paneCurrentCommand: "zsh",
          paneTitle: "",
          tmux: {
            session: "",
            window: "",
            pane: ""
          },
          repoRoot: "",
          isGitRepo: false
        };
      }
      throw new Error("probe_failed_after_invalid_identity");
    });

    const service = createEnvProbeService({
      sessionId,
      store,
      adapter: createAdapter({ probeActiveEnvironment }),
      socket,
      probeTargetPromise: Promise.resolve("/dev/ttys999"),
      logger: { warn }
    });

    await service.runHiddenEnvironmentProbe();

    const envProbeMessages = socket.sent
      .map((raw) => JSON.parse(raw) as { type?: string; data?: { kind?: string } })
      .filter((message) => message.type === "meta" && message.data?.kind === "env_probe");
    expect(envProbeMessages).toHaveLength(0);
    expect(store.getLatestEnvContext(sessionId)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "env_probe_failed",
        sessionId
      })
    );
  });

  it("keeps session fallback candidate when sessionId is whitespace", async () => {
    const sessionId = " ";
    const store = new SessionStore();
    store.ensure(sessionId);
    const socket = new FakeSocket();
    const warn = vi.fn();
    const probeActiveEnvironment = vi.fn(async () => ({
      activePaneId: "%1",
      paneCurrentPath: process.cwd(),
      paneCurrentCommand: "zsh",
      paneTitle: "workspace",
      tmux: {
        session: "s_whitespace",
        window: "1",
        pane: "1"
      },
      repoRoot: process.cwd(),
      isGitRepo: true
    }));

    const service = createEnvProbeService({
      sessionId,
      store,
      adapter: createAdapter({ probeActiveEnvironment }),
      socket,
      probeTargetPromise: Promise.resolve(null),
      logger: { warn }
    });

    await service.runHiddenEnvironmentProbe();

    expect(probeActiveEnvironment).toHaveBeenCalledTimes(1);
    expect(probeActiveEnvironment).toHaveBeenCalledWith(sessionId, sessionId);
    const envProbeMessages = socket.sent
      .map((raw) => JSON.parse(raw) as { type?: string; data?: { kind?: string; env?: { tmux?: { session?: string } } } })
      .filter((message) => message.type === "meta" && message.data?.kind === "env_probe");
    expect(envProbeMessages).toHaveLength(1);
    expect(envProbeMessages[0]?.data?.env?.tmux?.session).toBe("s_whitespace");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to session candidate when probeTargetPromise rejects", async () => {
    const sessionId = "s_reject_target_fallback";
    const store = new SessionStore();
    store.ensure(sessionId);
    const socket = new FakeSocket();
    const warn = vi.fn();
    const probeActiveEnvironment = vi.fn(async (_sessionId: string, target?: string) => ({
      activePaneId: "%1",
      paneCurrentPath: process.cwd(),
      paneCurrentCommand: "zsh",
      paneTitle: "workspace",
      tmux: {
        session: target ?? "",
        window: "1",
        pane: "1"
      },
      repoRoot: process.cwd(),
      isGitRepo: true
    }));

    const service = createEnvProbeService({
      sessionId,
      store,
      adapter: createAdapter({ probeActiveEnvironment }),
      socket,
      probeTargetPromise: Promise.reject(new Error("probe_target_lookup_failed")),
      logger: { warn }
    });

    await service.runHiddenEnvironmentProbe();

    expect(probeActiveEnvironment).toHaveBeenCalledTimes(1);
    expect(probeActiveEnvironment).toHaveBeenCalledWith(sessionId, sessionId);
    const envProbeMessages = socket.sent
      .map((raw) => JSON.parse(raw) as { type?: string; data?: { kind?: string } })
      .filter((message) => message.type === "meta" && message.data?.kind === "env_probe");
    expect(envProbeMessages).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs env_probe_failed when probeTargetPromise rejects and fallback probe fails", async () => {
    const sessionId = "s_reject_target_fail";
    const store = new SessionStore();
    store.ensure(sessionId);
    const socket = new FakeSocket();
    const warn = vi.fn();
    const probeActiveEnvironment = vi.fn(async () => {
      throw new Error("probe_failed_after_target_rejection");
    });

    const service = createEnvProbeService({
      sessionId,
      store,
      adapter: createAdapter({ probeActiveEnvironment }),
      socket,
      probeTargetPromise: Promise.reject(new Error("probe_target_lookup_failed")),
      logger: { warn }
    });

    await expect(service.runHiddenEnvironmentProbe()).resolves.toBeUndefined();

    expect(socket.sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "env_probe_failed",
        sessionId
      })
    );
  });

  it("stops retrying when socket closes after a failed attempt", async () => {
    const sessionId = "s_env_probe_socket_closed";
    const store = new SessionStore();
    store.ensure(sessionId);
    const socket = new FakeSocket();
    const warn = vi.fn();
    const probeActiveEnvironment = vi.fn(async () => {
      socket.readyState = 3;
      throw new Error("probe_failed_then_closed");
    });

    const service = createEnvProbeService({
      sessionId,
      store,
      adapter: createAdapter({ probeActiveEnvironment }),
      socket,
      probeTargetPromise: Promise.resolve(null),
      logger: { warn }
    });

    await expect(service.runHiddenEnvironmentProbe()).resolves.toBeUndefined();

    expect(probeActiveEnvironment).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(0);
  });
});
