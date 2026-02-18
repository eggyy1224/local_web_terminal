import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

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

function scriptBody(markup: string, id: string): string {
  const pattern = new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/script>`);
  const match = markup.match(pattern);
  expect(match?.[1]).toBeDefined();
  return match![1];
}

describe("App snapshot sidecar", () => {
  it("renders primary and alias hidden snapshot scripts with identical JSON", () => {
    const markup = renderToStaticMarkup(<App />);

    const primary = scriptBody(markup, "snapshot-json");
    const alias = scriptBody(markup, "ai-context-sidecar");
    expect(primary).toBe(alias);

    const parsed = JSON.parse(primary) as Record<string, unknown>;
    expect(parsed).toHaveProperty("sessionId");
    expect(parsed).toHaveProperty("context");
    expect(parsed).toHaveProperty("updatedAt");
    const context = parsed.context as Record<string, unknown>;
    const twoPane = context.twoPane as Record<string, unknown>;
    expect(twoPane).toBeTruthy();
    const codex = twoPane.codex as Record<string, unknown>;
    const workspace = twoPane.workspace as Record<string, unknown>;
    expect(Array.isArray(codex.lines)).toBe(true);
    expect(Array.isArray(workspace.lines)).toBe(true);
  });

  it("does not add visible control elements", () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<aside");
  });
});
