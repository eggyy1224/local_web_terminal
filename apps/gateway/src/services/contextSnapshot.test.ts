import { describe, expect, it, vi } from "vitest";
import { buildSessionContextSnapshot } from "./contextSnapshot.js";
import { SessionStore } from "./sessionStore.js";
import type { PaneContext, PaneSnapshot, TerminalAdapter } from "../types.js";
import type { AppLogger } from "../utils/logger.js";

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

  return { ...defaults, ...overrides };
}

function createLogger(): { logger: AppLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return {
    logger: {
      warn(payload) {
        warn(payload);
      }
    },
    warn
  };
}

describe("buildSessionContextSnapshot", () => {
  it("logs and keeps snapshot available when pane context and pane list fail", async () => {
    const store = new SessionStore();
    const sessionId = "s_ctx_log_fallback";
    store.ensure(sessionId);
    const { logger, warn } = createLogger();
    const snapshot = await buildSessionContextSnapshot(sessionId, {
      adapter: createAdapter({
        getPaneContext: async () => {
          throw new Error("pane_ctx_failed");
        },
        getActivePane: async () => {
          throw new Error("active_pane_failed");
        },
        listPanes: async () => {
          throw new Error("list_panes_failed");
        }
      }),
      store,
      logger
    });

    expect(snapshot).toBeTruthy();
    expect(snapshot?.recentErrors.some((item) => item.includes("tmux_active_pane_failed"))).toBe(true);
    expect(snapshot?.recentErrors.some((item) => item.includes("tmux_list_panes_failed"))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: "tmux_pane_context_failed", sessionId }));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: "tmux_active_pane_failed", sessionId }));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: "tmux_list_panes_failed", sessionId }));
  });

  it("logs pane capture failures without breaking snapshot", async () => {
    const store = new SessionStore();
    const sessionId = "s_ctx_capture_log";
    store.ensure(sessionId);
    const { logger, warn } = createLogger();
    const snapshot = await buildSessionContextSnapshot(sessionId, {
      adapter: createAdapter({
        capturePaneLines: async () => {
          throw new Error("capture_failed");
        }
      }),
      store,
      logger
    });

    expect(snapshot).toBeTruthy();
    expect(snapshot?.panes).toHaveLength(1);
    expect(snapshot?.panes[0]?.errors?.some((item) => item.includes("tmux_capture_failed"))).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "tmux_capture_failed",
        sessionId,
        paneId: "%1"
      })
    );
  });
});
