import { parseWsClientMessage, type WsClientMessage } from "@local-terminal/shared";

export function decodeWsClientMessage(raw: string | Buffer): WsClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return null;
  }
  return parseWsClientMessage(parsed);
}
