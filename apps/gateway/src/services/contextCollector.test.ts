import { describe, expect, it } from "vitest";
import { classifyPaneRole, isCodingAgentPaneSignal } from "./contextCollector.js";

describe("isCodingAgentPaneSignal", () => {
  it("does not treat generic cursor output lines as coding-agent", () => {
    const detected = isCodingAgentPaneSignal({
      currentCommand: "npm run test",
      title: "workspace",
      lines: ["button { cursor: pointer; }", "docs: keyboard cursor behavior"]
    });

    expect(detected).toBe(false);
  });

  it("treats cursor command as coding-agent signal", () => {
    const detected = isCodingAgentPaneSignal({
      currentCommand: "cursor .",
      title: "workspace",
      lines: []
    });

    expect(detected).toBe(true);
  });
});

describe("classifyPaneRole", () => {
  it("keeps repo pane classified as workspace when output contains cursor text", () => {
    const role = classifyPaneRole({
      currentCommand: "npm run lint",
      title: "workspace",
      lines: ["cursor: pointer"],
      workspaceKind: "git_repo_subdir"
    });

    expect(role).toBe("workspace");
  });

  it("classifies tool panes in repo as tool", () => {
    const role = classifyPaneRole({
      currentCommand: "lazygit",
      title: "workspace",
      workspaceKind: "git_repo_subdir"
    });

    expect(role).toBe("tool");
  });
});
