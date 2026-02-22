import { useCallback, useEffect, useRef, useState } from "react";
import type { WsClientMessage } from "@local-terminal/shared";
import { useSessionBootstrap } from "./hooks/useSessionBootstrap.js";
import { useSessionContextSync } from "./hooks/useSessionContextSync.js";
import { useTerminal } from "./hooks/useTerminal.js";
import { useWsStream } from "./hooks/useWsStream.js";
import { createApiClient, DEFAULT_GATEWAY_BASE } from "./services/apiClient.js";
import {
  createEmptyContext,
  mergeIncomingContext,
  syncEnvContextFromSnapshot,
  writeSnapshotScripts
} from "./services/snapshotWriter.js";

const GATEWAY_BASE = DEFAULT_GATEWAY_BASE;
const CONTEXT_BOOTSTRAP_TIMEOUT_MS =
  Number.parseInt(
    String(import.meta.env.VITE_CONTEXT_BOOTSTRAP_TIMEOUT_MS ?? import.meta.env.CONTEXT_BOOTSTRAP_TIMEOUT_MS ?? "1500"),
    10
  ) || 1500;
const api = createApiClient(GATEWAY_BASE);

export function App() {
  const terminalNodeRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const sendMessageRef = useRef<(message: WsClientMessage) => void>(() => {});
  const [sessionId, setSessionId] = useState<string | null>(null);

  const onTerminalData = useCallback((data: string) => {
    sendMessageRef.current({ type: "stdin", data });
  }, []);

  const onTerminalResize = useCallback((size: { cols: number; rows: number }) => {
    sendMessageRef.current({
      type: "resize",
      data: { cols: size.cols, rows: size.rows }
    });
  }, []);

  const { terminalRef, getDimensions, fit } = useTerminal({
    terminalNodeRef,
    onData: onTerminalData,
    onResize: onTerminalResize
  });

  const isSessionCurrent = useCallback((targetSessionId: string | null | undefined): targetSessionId is string => {
    return Boolean(targetSessionId) && !disposedRef.current && sessionIdRef.current === targetSessionId;
  }, []);

  const {
    refreshContext,
    onContextSnapshot,
    onEnvProbe,
    resetContextSidecar,
    seedSessionContext
  } = useSessionContextSync({ gatewayBase: GATEWAY_BASE, isSessionCurrent, sessionIdRef });

  const onStdout = useCallback(
    (data: string) => {
      terminalRef.current?.write(data);
    },
    [terminalRef]
  );

  const handleBootstrapTimeout = useCallback(
    async (nextSessionId: string) => {
      await refreshContext(nextSessionId);
    },
    [refreshContext]
  );

  const { sendMessage } = useWsStream({
    gatewayBase: GATEWAY_BASE,
    sessionId,
    contextBootstrapTimeoutMs: CONTEXT_BOOTSTRAP_TIMEOUT_MS,
    getDimensions,
    onStdout,
    onContextSnapshot,
    onEnvProbe,
    onBootstrapTimeout: handleBootstrapTimeout,
    disposedRef
  });

  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  const createSession = useCallback(async (): Promise<string> => {
    const dims = getDimensions();
    const created = await api<{ sessionId: string }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        cols: dims?.cols ?? 120,
        rows: dims?.rows ?? 35
      })
    });
    return created.sessionId;
  }, [getDimensions]);

  const { bootSession } = useSessionBootstrap({ createSession });

  useEffect(() => {
    disposedRef.current = false;
    resetContextSidecar();

    let active = true;
    const boot = async () => {
      try {
        const nextSessionId = await bootSession();
        if (!active || disposedRef.current) {
          return;
        }
        sessionIdRef.current = nextSessionId;
        seedSessionContext(nextSessionId);
        fit();
        setSessionId(nextSessionId);
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn("session_bootstrap_failed", error);
        }
      }
    };

    void boot();
    return () => {
      active = false;
      disposedRef.current = true;
      sessionIdRef.current = null;
      setSessionId(null);
    };
  }, [bootSession, fit, resetContextSidecar, seedSessionContext]);

  return (
    <div className="terminal-only">
      <div ref={terminalNodeRef} className="terminal-root" />
    </div>
  );
}

export { createEmptyContext, mergeIncomingContext, syncEnvContextFromSnapshot, writeSnapshotScripts };
export { readTabSessionId, writeTabSessionId } from "./hooks/useSessionBootstrap.js";
