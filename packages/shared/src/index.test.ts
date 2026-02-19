import { describe, expect, it } from "vitest";
import {
  LOCAL_ORIGIN_DEFAULT,
  parseWsClientMessage,
  parseWsServerMessage,
  type WsClientMessage,
  type WsServerMessage
} from "./index.js";

describe("LOCAL_ORIGIN_DEFAULT", () => {
  it("contains both loopback defaults", () => {
    const origins = LOCAL_ORIGIN_DEFAULT.split(",").map((item) => item.trim());
    expect(origins).toEqual(expect.arrayContaining(["http://127.0.0.1:5173", "http://localhost:5173"]));
    expect(origins).toHaveLength(2);
  });
});

describe("shared runtime contracts", () => {
  it("keeps valid stdin ws client shape", () => {
    const message: WsClientMessage = {
      type: "stdin",
      data: "pwd\r"
    };

    expect(message.type).toBe("stdin");
    expect(typeof message.data).toBe("string");
    expect(message.data).toContain("pwd");
    expect(parseWsClientMessage(message)).toEqual(message);
  });

  it("rejects invalid ws client shape", () => {
    expect(parseWsClientMessage({ type: "stdin", data: 42 })).toBeNull();
    expect(parseWsClientMessage({ type: "resize", data: { cols: 0, rows: 10 } })).toBeNull();
  });

  it("keeps valid env probe ws server meta shape", () => {
    const message: WsServerMessage = {
      type: "meta",
      data: {
        kind: "env_probe",
        env: {
          activePaneId: "%1",
          role: "workspace",
          realCwd: "/tmp/workspace",
          repoRoot: "/tmp/workspace",
          isGitRepo: true,
          tmux: {
            session: "s_test",
            window: "0",
            pane: "1"
          },
          capturedAt: Date.now(),
          version: 1
        }
      }
    };

    expect(message.type).toBe("meta");
    expect(message.data.kind).toBe("env_probe");
    expect(message.data.env.tmux.session).toBe("s_test");
    expect(parseWsServerMessage(message)).toEqual(message);
  });

  it("keeps valid context snapshot ws server meta shape", () => {
    const message: WsServerMessage = {
      type: "meta",
      data: {
        kind: "context_snapshot",
        reason: "connect",
        updatedAt: Date.now(),
        snapshot: {
          timestamp: Date.now(),
          sessionId: "s_123",
          cwd: "/tmp/workspace",
          repoRoot: "/tmp/workspace",
          branch: "main",
          gitStatusPorcelain: "",
          diffStat: "",
          recentErrors: [],
          tmuxPanes: [],
          shell: "zsh",
          recentOutput: [],
          lastCommands: [],
          panes: []
        }
      }
    };

    expect(message.type).toBe("meta");
    expect(message.data.kind).toBe("context_snapshot");
    expect(message.data.reason).toBe("connect");
    expect(message.data.snapshot.sessionId).toBe("s_123");
    expect(parseWsServerMessage(message)).toEqual(message);
  });

  it("rejects invalid ws server shape", () => {
    expect(parseWsServerMessage({ type: "meta", data: { kind: "env_probe" } })).toBeNull();
    expect(
      parseWsServerMessage({
        type: "meta",
        data: {
          kind: "context_snapshot",
          reason: "connect",
          updatedAt: 1
        }
      })
    ).toBeNull();
  });
});
