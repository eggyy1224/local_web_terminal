import { describe, expect, it } from "vitest";
import { maskSensitive } from "./index.js";

describe("maskSensitive", () => {
  it("masks token-like values", () => {
    const masked = maskSensitive("token=abc123");
    expect(masked).toContain("[REDACTED]");
    expect(masked).not.toContain("abc123");
  });
});
