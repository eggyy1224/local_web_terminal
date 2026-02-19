import { describe, expect, it } from "vitest";
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
});
