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
});
