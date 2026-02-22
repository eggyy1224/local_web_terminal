import { parseWsServerMessage, type WsServerMessage } from "@local-terminal/shared";

export function toWsBaseUrl(gatewayBase: string): string {
  return gatewayBase.replace("http://", "ws://").replace("https://", "wss://");
}

export function parseServerEventPayload(payload: unknown): WsServerMessage | null {
  if (typeof payload !== "string") {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payload);
  } catch {
    return null;
  }

  return parseWsServerMessage(parsedJson);
}
