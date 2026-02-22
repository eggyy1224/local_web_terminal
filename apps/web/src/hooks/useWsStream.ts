import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import {
  type EnvContext,
  type SessionContext,
  type WsClientMessage
} from "@local-terminal/shared";
import type { TerminalSize } from "./useTerminal.js";
import { parseServerEventPayload, toWsBaseUrl } from "./wsStreamUtils.js";

interface UseWsStreamOptions {
  gatewayBase: string;
  sessionId: string | null;
  contextBootstrapTimeoutMs: number;
  getDimensions: () => TerminalSize | null;
  onStdout: (data: string) => void;
  onContextSnapshot: (snapshot: SessionContext, updatedAt: number, sessionId: string) => void;
  onEnvProbe: (env: EnvContext, sessionId: string) => void;
  onBootstrapTimeout: (sessionId: string) => Promise<void> | void;
  disposedRef: MutableRefObject<boolean>;
}

interface UseWsStreamResult {
  sendMessage: (message: WsClientMessage) => void;
}

export function useWsStream(options: UseWsStreamOptions): UseWsStreamResult {
  const {
    gatewayBase,
    sessionId,
    contextBootstrapTimeoutMs,
    getDimensions,
    onStdout,
    onContextSnapshot,
    onEnvProbe,
    onBootstrapTimeout,
    disposedRef
  } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const bootstrapTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  const clearBootstrapTimer = useCallback(() => {
    if (bootstrapTimerRef.current !== null) {
      window.clearTimeout(bootstrapTimerRef.current);
      bootstrapTimerRef.current = null;
    }
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const sendMessage = useCallback((message: WsClientMessage) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    return () => {
      clearBootstrapTimer();
      clearReconnectTimer();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [clearBootstrapTimer, clearReconnectTimer]);

  useEffect(() => {
    if (!sessionId || disposedRef.current) {
      return;
    }

    let cancelled = false;
    const connectWs = (targetSessionId: string) => {
      if (cancelled || disposedRef.current) {
        return;
      }

      const base = toWsBaseUrl(gatewayBase);
      const ws = new WebSocket(`${base}/ws/sessions/${targetSessionId}/stream`);
      wsRef.current = ws;
      let hasReceivedContextSnapshot = false;

      ws.onopen = () => {
        const dims = getDimensions();
        if (dims) {
          sendMessage({
            type: "resize",
            data: { cols: dims.cols, rows: dims.rows }
          });
        }

        clearBootstrapTimer();
        bootstrapTimerRef.current = window.setTimeout(() => {
          if (cancelled || disposedRef.current || sessionId !== targetSessionId || hasReceivedContextSnapshot) {
            return;
          }
          void onBootstrapTimeout(targetSessionId);
        }, contextBootstrapTimeoutMs);
      };

      ws.onmessage = (event) => {
        const parsed = parseServerEventPayload(event.data);
        if (!parsed) {
          if (import.meta.env.DEV) {
            if (typeof event.data !== "string") {
              console.warn("ignored_non_string_ws_payload");
            } else {
              try {
                JSON.parse(event.data);
                console.warn("ignored_invalid_ws_message");
              } catch {
                console.warn("ignored_invalid_ws_json");
              }
            }
          }
          return;
        }

        if (parsed.type === "stdout") {
          onStdout(String(parsed.data));
          return;
        }

        if (parsed.type === "meta" && parsed.data.kind === "context_snapshot") {
          hasReceivedContextSnapshot = true;
          clearBootstrapTimer();
          onContextSnapshot(parsed.data.snapshot, parsed.data.updatedAt, targetSessionId);
          return;
        }

        if (parsed.type === "meta" && parsed.data.kind === "env_probe") {
          onEnvProbe(parsed.data.env, targetSessionId);
        }
      };

      ws.onclose = () => {
        clearBootstrapTimer();
        if (cancelled || disposedRef.current || sessionId !== targetSessionId) {
          return;
        }

        clearReconnectTimer();
        reconnectTimerRef.current = window.setTimeout(() => {
          if (cancelled || disposedRef.current || sessionId !== targetSessionId) {
            return;
          }
          connectWs(targetSessionId);
        }, 1200);
      };
    };

    connectWs(sessionId);
    return () => {
      cancelled = true;
      clearBootstrapTimer();
      clearReconnectTimer();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [
    clearBootstrapTimer,
    clearReconnectTimer,
    contextBootstrapTimeoutMs,
    gatewayBase,
    getDimensions,
    onBootstrapTimeout,
    onContextSnapshot,
    disposedRef,
    onEnvProbe,
    onStdout,
    sendMessage,
    sessionId
  ]);

  return { sendMessage };
}
