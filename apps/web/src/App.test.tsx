import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App, createEmptyContext, readTabSessionId, writeSnapshotScripts, writeTabSessionId } from "./App";

vi.mock("xterm", () => ({
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

vi.mock("xterm-addon-fit", () => ({
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
    expect(parsed).toHaveProperty("twoPane");
    const twoPane = parsed.twoPane as Record<string, unknown>;
    const codex = twoPane.codex as Record<string, unknown>;
    const workspace = twoPane.workspace as Record<string, unknown>;
    expect(Array.isArray(codex.lines)).toBe(true);
    expect(Array.isArray(workspace.lines)).toBe(true);

    expect(aiSnapshot.textContent.includes("<")).toBe(false);
    const parsedAi = JSON.parse(aiSnapshot.textContent) as Record<string, unknown>;
    expect(parsedAi).toHaveProperty("twoPane");
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
          role: "codex",
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
