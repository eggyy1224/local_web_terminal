import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App, createEmptyContext, writeSnapshotScripts } from "./App";

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
  });

  it("writes escaped snapshot JSON into fixed script placeholders", () => {
    const primary = { textContent: "" };
    const alias = { textContent: "" };
    const fakeDocument = {
      querySelector(selector: string): { textContent: string } | null {
        if (selector === "script#snapshot-json[type='application/json']") {
          return primary;
        }
        if (selector === "script#ai-context-sidecar[type='application/json']") {
          return alias;
        }
        return null;
      }
    };

    writeSnapshotScripts(
      {
        sessionId: "s_test",
        context: createEmptyContext(),
        updatedAt: 123
      },
      fakeDocument
    );

    expect(primary.textContent).toBe(alias.textContent);
    expect(primary.textContent.includes("<")).toBe(false);
    const parsed = JSON.parse(primary.textContent) as Record<string, unknown>;
    expect(parsed).toHaveProperty("context");
  });
});
