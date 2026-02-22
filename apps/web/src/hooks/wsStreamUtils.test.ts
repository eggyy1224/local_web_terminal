import { describe, expect, it } from "vitest";
import { parseServerEventPayload, toWsBaseUrl } from "./wsStreamUtils.js";

describe("wsStreamUtils", () => {
  it("converts gateway base url from http(s) to ws(s)", () => {
    expect(toWsBaseUrl("http://localhost:8787")).toBe("ws://localhost:8787");
    expect(toWsBaseUrl("https://example.com")).toBe("wss://example.com");
  });

  it("returns null for non-string payload", () => {
    expect(parseServerEventPayload({})).toBeNull();
  });

  it("returns null for invalid json payload", () => {
    expect(parseServerEventPayload("{" )).toBeNull();
  });

  it("returns null for json that is not a valid ws server message", () => {
    expect(parseServerEventPayload(JSON.stringify({ type: "unknown" }))).toBeNull();
  });

  it("parses valid stdout ws message", () => {
    const parsed = parseServerEventPayload(JSON.stringify({ type: "stdout", data: "ok" }));
    expect(parsed).toEqual({ type: "stdout", data: "ok" });
  });
});
