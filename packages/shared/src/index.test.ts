import { describe, expect, it } from "vitest";
import { LOCAL_ORIGIN_DEFAULT, type WsClientMessage, type WsServerMessage } from "./index.js";

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
  });
});
