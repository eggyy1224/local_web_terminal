import { describe, expect, it } from "vitest";
import { assertRawTmuxTarget, normalizeUpstreamPaneTarget } from "./paneTargetNormalizer.js";

describe("normalizeUpstreamPaneTarget", () => {
  it("keeps raw pane id unchanged", () => {
    expect(normalizeUpstreamPaneTarget("%250")).toBe("%250");
    expect(normalizeUpstreamPaneTarget("%2512")).toBe("%2512");
  });

  it("extracts pane_id from composite targets", () => {
    expect(normalizeUpstreamPaneTarget("%25\u001f1\u001f1\u001fhost\u001f/tmp\u001fcoding_agent")).toBe("%25");
    expect(normalizeUpstreamPaneTarget("%26\\0372\\0370\\037host\\037/tmp\\037workspace")).toBe("%26");
  });

  it("can decode encoded composite target to raw pane id", () => {
    expect(normalizeUpstreamPaneTarget("%2525%5C0371%5C0371%5C037host%5C037%2Ftmp%5C037coding_agent")).toBe("%25");
  });

  it("rejects values that cannot be normalized to raw pane id", () => {
    expect(() => normalizeUpstreamPaneTarget("not-pane\\03712\\0370\\037host")).toThrow("rawTarget");
    expect(() => normalizeUpstreamPaneTarget("not-pane\\03712\\0370\\037host")).toThrow("reason");
  });
});

describe("assertRawTmuxTarget", () => {
  it("accepts raw tmux pane target values", () => {
    expect(assertRawTmuxTarget("%42")).toBe("%42");
    expect(assertRawTmuxTarget("s_main:1.0")).toBe("s_main:1.0");
  });

  it("rejects composite and empty targets with actionable error", () => {
    expect(() => assertRawTmuxTarget("%25\\0371\\0370\\037host")).toThrow("rawTarget");
    expect(() => assertRawTmuxTarget("   ")).toThrow("empty_target");
  });
});
