import { describe, expect, it } from "vitest";
import { detectRiskFlags, maskSensitive } from "./index.js";

describe("maskSensitive", () => {
  it("masks token-like values", () => {
    const masked = maskSensitive("token=abc123");
    expect(masked).toContain("[REDACTED]");
    expect(masked).not.toContain("abc123");
  });
});

describe("detectRiskFlags", () => {
  it("flags explicit delete commands", () => {
    expect(detectRiskFlags("rm -rf /tmp/a")).toContain("destructive-delete");
    expect(detectRiskFlags("echo hi")).toEqual([]);
  });
});
