import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EnvContext, PaneRole, PaneView } from "@local-terminal/shared";
import {
  App,
  createEmptyContext,
  syncEnvContextFromSnapshot,
  mergeIncomingContext,
  readTabSessionId,
  writeSnapshotScripts,
  writeTabSessionId
} from "./App";

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    dispose() {}
  }
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit() {}
    proposeDimensions() {
      return { cols: 120, rows: 35 };
    }
  }
}));

describe("App snapshot sidecar", () => {
  it("does not render hidden snapshot scripts in React tree", () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).not.toContain("id=\"snapshot-json\"");
    expect(markup).not.toContain("id=\"ai-context-sidecar\"");
  });

  it("does not add visible control elements", () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<aside");
  });

  it("ships fixed snapshot placeholders outside React tree", () => {
    const indexHtmlPath = path.resolve(process.cwd(), "index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");
    expect(html).toContain("id=\"snapshot-json\"");
    expect(html).toContain("id=\"ai-context-sidecar\"");
    expect(html).toContain("id=\"ai-snapshot\"");
  });

  it("writes escaped snapshot JSON into fixed script placeholders", () => {
    const primary = { textContent: "" };
    const alias = { textContent: "" };
    const aiSnapshot = { textContent: "" };
    const fakeDocument = {
      querySelector(selector: string): { textContent: string } | null {
        if (selector === "script#snapshot-json[type='application/json']") {
          return primary;
        }
        if (selector === "script#ai-context-sidecar[type='application/json']") {
          return alias;
        }
        if (selector === "#ai-snapshot") {
          return aiSnapshot;
        }
        return null;
      }
    };

    writeSnapshotScripts(
      {
        context: createEmptyContext(),
        updatedAt: 123
      },
      fakeDocument
    );

    expect(primary.textContent).toBe(alias.textContent);
    expect(primary.textContent.includes("<")).toBe(false);
    const parsed = JSON.parse(primary.textContent) as Record<string, unknown>;
    expect(parsed).toHaveProperty("panes");
    const panes = parsed.panes as unknown[];
    expect(Array.isArray(panes)).toBe(true);

    expect(aiSnapshot.textContent.includes("<")).toBe(false);
    const parsedAi = JSON.parse(aiSnapshot.textContent) as Record<string, unknown>;
    expect(parsedAi).toHaveProperty("panes");
  });

  it("injects hidden env context only into ai snapshot payload", () => {
    const primary = { textContent: "" };
    const alias = { textContent: "" };
    const aiSnapshot = { textContent: "" };
    const fakeDocument = {
      querySelector(selector: string): { textContent: string } | null {
        if (selector === "script#snapshot-json[type='application/json']") {
          return primary;
        }
        if (selector === "script#ai-context-sidecar[type='application/json']") {
          return alias;
        }
        if (selector === "#ai-snapshot") {
          return aiSnapshot;
        }
        return null;
      }
    };

    writeSnapshotScripts(
      {
        context: createEmptyContext(),
        updatedAt: 456,
        envContext: {
          activePaneId: "%33",
          role: "coding_agent",
          realCwd: "/tmp/workspace",
          repoRoot: "/tmp/workspace",
          isGitRepo: true,
          tmux: {
            session: "s_abc",
            window: "1",
            pane: "3"
          },
          capturedAt: 111,
          version: 2
        }
      },
      fakeDocument
    );

    const parsedPrimary = JSON.parse(primary.textContent) as Record<string, unknown>;
    expect(parsedPrimary).not.toHaveProperty("envContext");
    const parsedAi = JSON.parse(aiSnapshot.textContent) as Record<string, unknown>;
    expect(parsedAi).toHaveProperty("envContext");
    const envText = String(parsedAi.envContextText ?? "");
    expect(envText).toContain("[ENV_CONTEXT]");
    expect(envText).toContain("activePaneId: %33");
    expect(envText).toContain("[/ENV_CONTEXT]");
  });

  it("keeps push-first context flow without fixed polling interval", () => {
    const appSourcePath = path.resolve(process.cwd(), "src/App.tsx");
    const source = fs.readFileSync(appSourcePath, "utf8");
    expect(source.includes("setInterval(")).toBe(false);
    expect(source.includes("useWsStream")).toBe(true);
  });

  it("marks disposed and clears session binding on cleanup", () => {
    const appSourcePath = path.resolve(process.cwd(), "src/App.tsx");
    const source = fs.readFileSync(appSourcePath, "utf8");
    expect(source.includes("disposedRef.current = true")).toBe(true);
    expect(source.includes("sessionIdRef.current = null")).toBe(true);
  });

  it("keeps context/session guards in app and context sync hook", () => {
    const appSourcePath = path.resolve(process.cwd(), "src/App.tsx");
    const appSource = fs.readFileSync(appSourcePath, "utf8");
    expect(appSource.includes("const isSessionCurrent = useCallback")).toBe(true);
    expect(appSource.includes("useSessionContextSync")).toBe(true);
    expect(appSource.includes("gatewayBase: GATEWAY_BASE")).toBe(true);

    const syncHookPath = path.resolve(process.cwd(), "src/hooks/useSessionContextSync.ts");
    const syncSource = fs.readFileSync(syncHookPath, "utf8");
    expect(syncSource.includes("createApiClient(gatewayBase)")).toBe(true);
    expect(syncSource.includes("if (!isSessionCurrent(targetSessionId))")).toBe(true);
    expect(syncSource.includes("context_refresh_session_mismatch")).toBe(true);
    expect(syncSource.includes("context_snapshot_session_mismatch")).toBe(true);
  });

  it("guards websocket parsing and reconnect with disposed/session checks", () => {
    const wsHookPath = path.resolve(process.cwd(), "src/hooks/useWsStream.ts");
    const source = fs.readFileSync(wsHookPath, "utf8");
    expect(source.includes("parseServerEventPayload")).toBe(true);
    expect(source.includes("ignored_invalid_ws_json")).toBe(true);
    expect(source.includes("toWsBaseUrl")).toBe(true);
    expect(source.includes("disposedRef.current")).toBe(true);
    expect(source.includes("const isSessionInactive = (targetSessionId: string)")).toBe(true);
    expect(source.includes("sessionIdRef.current !== targetSessionId")).toBe(true);
    expect(source.includes("onContextSnapshot(parsed.data.snapshot, parsed.data.updatedAt, targetSessionId)")).toBe(true);
    expect(source.includes("onEnvProbe(parsed.data.env, targetSessionId)")).toBe(true);
  });

  it("uses unicode11 width handling for terminal rendering", () => {
    const terminalHookPath = path.resolve(process.cwd(), "src/hooks/useTerminal.ts");
    const source = fs.readFileSync(terminalHookPath, "utf8");
    expect(source.includes("Unicode11Addon")).toBe(true);
    expect(source.includes("terminal.unicode.activeVersion")).toBe(true);
    expect(source.includes("WebglAddon")).toBe(true);
  });

  it("uses a stable bootstrap-timeout callback for ws hook", () => {
    const appSourcePath = path.resolve(process.cwd(), "src/App.tsx");
    const source = fs.readFileSync(appSourcePath, "utf8");
    expect(source.includes("const handleBootstrapTimeout = useCallback")).toBe(true);
    expect(source.includes("onBootstrapTimeout: handleBootstrapTimeout")).toBe(true);
  });

  it("merges incoming context with required defaults", () => {
    const merged = mergeIncomingContext({
      timestamp: 42,
      sessionId: "s_push",
      cwd: "/tmp/demo",
      repoRoot: "",
      branch: "",
      gitStatusPorcelain: "",
      diffStat: "",
      recentErrors: [],
      tmuxPanes: [],
      shell: "zsh",
      recentOutput: [],
      lastCommands: [],
      panes: []
    });

    expect(merged.sessionId).toBe("s_push");
    expect(Array.isArray(merged.panes)).toBe(true);
    expect(Array.isArray(merged.recentOutput)).toBe(true);
  });

  it("syncs env context from active pane in snapshot data", () => {
    const now = Date.now();
    const tool: PaneRole = "tool";
    const workspace: PaneRole = "workspace";
    const base = {
      sessionId: "s_sync",
      cwd: "/tmp/workspace",
      repoRoot: "/tmp/repo",
      branch: "main",
      gitStatusPorcelain: "",
      diffStat: "",
      recentErrors: [],
      tmuxPanes: [],
      shell: "zsh",
      recentOutput: [],
      lastCommands: [],
      panes: [
        {
          id: "%1",
          isActive: false,
          role: tool,
          lines: [],
          cwd: "/tmp/tool",
          repoRoot: "/tmp/repo"
        },
        {
          id: "%2",
          isActive: true,
          role: workspace,
          lines: [],
          cwd: "/tmp/workspace",
          repoRoot: "/tmp/repo"
        }
      ] satisfies PaneView[],
      timestamp: now
    };

    const synced = syncEnvContextFromSnapshot(
      { ...base, updatedAt: now },
      {
        role: "tool",
        activePaneId: "%1",
        realCwd: "/tmp/tool",
        repoRoot: "/tmp/repo",
        isGitRepo: true,
        tmux: { session: "s", window: "0", pane: "1" },
        capturedAt: now - 10_000,
        version: 7
      } as EnvContext
    );

    expect(synced).toMatchObject({
      activePaneId: "%2",
      role: "workspace",
      realCwd: "/tmp/workspace",
      repoRoot: "/tmp/repo",
      isGitRepo: true,
      tmux: { session: "s", window: "0", pane: "%2" },
      version: 7
    });
    expect(synced?.capturedAt).toBe(now);
  });

  it("keeps current env context when panes payload is not an array", () => {
    const now = Date.now();
    const current: EnvContext = {
      activePaneId: "%1",
      role: "coding_agent",
      realCwd: "/tmp/current",
      repoRoot: "/tmp/current-repo",
      isGitRepo: true,
      tmux: { session: "s", window: "0", pane: "1" },
      capturedAt: now - 20_000,
      version: 3
    };

    const invalidSnapshot = {
      ...createEmptyContext(),
      panes: null,
      timestamp: now,
      sessionId: "s_invalid_panes",
      updatedAt: now
    } as unknown as Parameters<typeof syncEnvContextFromSnapshot>[0];

    const synced = syncEnvContextFromSnapshot(
      invalidSnapshot,
      current
    );

    expect(synced).toBe(current);
  });
});

describe("tab session storage", () => {
  it("reads tab session id from provided storage", () => {
    const getItem = vi.fn((key: string) => (key === "local-web-terminal:session" ? "s_tab_1" : null));
    const sessionId = readTabSessionId({ getItem });

    expect(sessionId).toBe("s_tab_1");
    expect(getItem).toHaveBeenCalledWith("local-web-terminal:session");
  });

  it("writes tab session id to provided storage", () => {
    const setItem = vi.fn();
    writeTabSessionId("s_tab_2", { setItem });

    expect(setItem).toHaveBeenCalledWith("local-web-terminal:session", "s_tab_2");
  });
});
