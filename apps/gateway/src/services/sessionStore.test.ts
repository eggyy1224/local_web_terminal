import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "./sessionStore.js";

function appendCommand(store: SessionStore, sessionId: string, command: string): void {
  store.appendInput(sessionId, `${command}\r`);
}

describe("SessionStore", () => {
  it("returns null context for unknown session", () => {
    const store = new SessionStore();
    expect(store.getContext("missing")).toBeNull();
  });

  it("records commands with backspace handling and masking", () => {
    const store = new SessionStore();
    const sessionId = "s_store_input";
    store.ensure(sessionId);

    store.appendInput(sessionId, "abc\u007fd\r");
    store.appendInput(sessionId, "token=abc123\r");

    const context = store.getContext(sessionId);
    expect(context).toBeTruthy();
    expect(context?.lastCommands[0]).toBe("abd");
    expect(context?.lastCommands[1]).toContain("[REDACTED]");
    expect(context?.lastCommands[1]).not.toContain("abc123");
  });

  it("enforces command and output windows", () => {
    const store = new SessionStore();
    const sessionId = "s_store_limits";
    store.ensure(sessionId);

    for (let i = 0; i < 100; i += 1) {
      appendCommand(store, sessionId, `cmd-${i}`);
    }

    for (let i = 0; i < 500; i += 1) {
      store.appendStdout(sessionId, `chunk-${i}`);
    }

    const context = store.getContext(sessionId);
    expect(context).toBeTruthy();
    expect(context?.lastCommands).toHaveLength(20);
    expect(context?.lastCommands[0]).toBe("cmd-80");
    expect(context?.lastCommands[19]).toBe("cmd-99");
    expect(context?.recentOutput).toHaveLength(50);
    expect(context?.recentOutput[0]).toContain("chunk-450");
    expect(context?.recentOutput[49]).toContain("chunk-499");
  });

  it("keeps latest env context by version", () => {
    const store = new SessionStore();
    const sessionId = "s_store_env";
    store.ensure(sessionId);

    const firstVersion = store.nextEnvProbeVersion(sessionId);
    store.setLatestEnvContext(sessionId, {
      activePaneId: "%1",
      role: "workspace",
      realCwd: "/tmp",
      repoRoot: "/tmp",
      isGitRepo: false,
      tmux: {
        session: "s",
        window: "0",
        pane: "1"
      },
      capturedAt: 1,
      version: firstVersion
    });

    store.setLatestEnvContext(sessionId, {
      activePaneId: "%2",
      role: "coding_agent",
      realCwd: "/tmp/new",
      repoRoot: "/tmp/new",
      isGitRepo: true,
      tmux: {
        session: "s",
        window: "0",
        pane: "2"
      },
      capturedAt: 2,
      version: firstVersion - 1
    });

    const latestAfterStale = store.getLatestEnvContext(sessionId);
    expect(latestAfterStale?.activePaneId).toBe("%1");

    const secondVersion = store.nextEnvProbeVersion(sessionId);
    store.setLatestEnvContext(sessionId, {
      activePaneId: "%3",
      role: "coding_agent",
      realCwd: "/tmp/latest",
      repoRoot: "/tmp/latest",
      isGitRepo: true,
      tmux: {
        session: "s",
        window: "0",
        pane: "3"
      },
      capturedAt: 3,
      version: secondVersion
    });

    const latest = store.getLatestEnvContext(sessionId);
    expect(latest?.activePaneId).toBe("%3");
    expect(latest?.version).toBe(secondVersion);
  });

  it("releases session explicitly", () => {
    const store = new SessionStore();
    const sessionId = "s_store_release";
    store.ensure(sessionId);
    store.appendStdout(sessionId, "line");

    expect(store.getContext(sessionId)).toBeTruthy();
    store.release(sessionId);
    expect(store.getContext(sessionId)).toBeNull();
  });

  it("falls back to another existing session when releasing most recent session", () => {
    const store = new SessionStore();
    const sessionA = "s_store_a";
    const sessionB = "s_store_b";
    store.ensure(sessionA);
    store.ensure(sessionB);
    expect(store.getMostRecentSessionId()).toBe(sessionB);

    store.release(sessionB);
    expect(store.getMostRecentSessionId()).toBe(sessionA);
    expect(store.getContext(sessionA)).toBeTruthy();
  });

  it("prunes sessions by ttl", () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const store = new SessionStore(50);
      const oldSessionId = "s_store_old";
      const freshSessionId = "s_store_fresh";
      store.ensure(oldSessionId);
      now = 1_020;
      store.ensure(freshSessionId);
      now = 1_030;
      store.appendStdout(freshSessionId, "still-active");

      now = 1_070;
      const removed = store.pruneExpiredSessions();
      expect(removed).toContain(oldSessionId);
      expect(removed).not.toContain(freshSessionId);
      expect(store.getContext(oldSessionId)).toBeNull();
      expect(store.getContext(freshSessionId)).toBeTruthy();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("returns defensive pane copies from store", () => {
    const store = new SessionStore();
    const sessionId = "s_store_panes";
    store.ensure(sessionId);

    store.setLatestPanes(sessionId, [
      {
        id: "%1",
        title: "pane-1",
        cwd: "/tmp",
        role: "workspace",
        lines: ["line-1"],
        errors: ["err-1"]
      }
    ]);

    const panes = store.getLatestPanes(sessionId);
    panes[0]?.lines.push("line-2");
    panes[0]?.errors?.push("err-2");

    const context = store.getContext(sessionId);
    expect(context?.panes[0]?.lines).toEqual(["line-1"]);
    expect(context?.panes[0]?.errors).toEqual(["err-1"]);
  });
});
