import { useCallback, useEffect, useRef, useState } from "react";
import type { EnvContext, SessionContext, WsClientMessage } from "@local-terminal/shared";
import { useSessionBootstrap } from "./hooks/useSessionBootstrap.js";
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

function logWarn(code: string, error?: unknown): void {
  if (!import.meta.env.DEV) {
    return;
  }
  console.warn(code, error);
}

export function App() {
  const terminalNodeRef = useRef<HTMLDivElement | null>(null);
  const latestContextRef = useRef<SessionContext>(createEmptyContext());
  const latestEnvContextRef = useRef<EnvContext | null>(null);
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

  const refreshContext = useCallback(async (sessionIdHint?: string) => {
    const targetSessionId = sessionIdHint ?? sessionIdRef.current;
    if (!targetSessionId) {
      return false;
    }

    try {
      const context = await api<SessionContext>(`/api/context/${targetSessionId}`);
      const mergedContext = mergeIncomingContext(context);
      const syncedEnvContext = syncEnvContextFromSnapshot(
        { ...mergedContext, updatedAt: Date.now() },
        latestEnvContextRef.current
      );
      latestEnvContextRef.current = syncedEnvContext;
      latestContextRef.current = mergedContext;
      writeSnapshotScripts({
        context: mergedContext,
        updatedAt: Date.now(),
        envContext: syncedEnvContext
      });
      return true;
    } catch (error) {
      logWarn("context_refresh_failed", error);
      return false;
    }
  }, []);

  const onStdout = useCallback(
    (data: string) => {
      terminalRef.current?.write(data);
    },
    [terminalRef]
  );

  const onContextSnapshot = useCallback((snapshot: SessionContext, updatedAt: number) => {
    const mergedContext = mergeIncomingContext(snapshot);
    const syncedEnvContext = syncEnvContextFromSnapshot(
      { ...mergedContext, updatedAt },
      latestEnvContextRef.current
    );
    latestEnvContextRef.current = syncedEnvContext;
    latestContextRef.current = mergedContext;
    writeSnapshotScripts({
      context: mergedContext,
      updatedAt,
      envContext: syncedEnvContext
    });
  }, []);

  const onEnvProbe = useCallback((incoming: EnvContext) => {
    const current = latestEnvContextRef.current;
    if (!current || incoming.version >= current.version) {
      latestEnvContextRef.current = incoming;
      writeSnapshotScripts({
        context: latestContextRef.current,
        updatedAt: Date.now(),
        envContext: incoming
      });
    }
  }, []);

  const { sendMessage } = useWsStream({
    gatewayBase: GATEWAY_BASE,
    sessionId,
    contextBootstrapTimeoutMs: CONTEXT_BOOTSTRAP_TIMEOUT_MS,
    getDimensions,
    onStdout,
    onContextSnapshot,
    onEnvProbe,
    onBootstrapTimeout: async (nextSessionId) => {
      await refreshContext(nextSessionId);
    },
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
    latestContextRef.current = createEmptyContext();
    latestEnvContextRef.current = null;
    writeSnapshotScripts({
      context: createEmptyContext(),
      updatedAt: Date.now(),
      envContext: null
    });

    let active = true;
    const boot = async () => {
      try {
        const nextSessionId = await bootSession();
        if (!active || disposedRef.current) {
          return;
        }
        sessionIdRef.current = nextSessionId;
        latestContextRef.current = {
          ...createEmptyContext(),
          sessionId: nextSessionId
        };
        writeSnapshotScripts({
          context: latestContextRef.current,
          updatedAt: Date.now(),
          envContext: latestEnvContextRef.current
        });
        fit();
        setSessionId(nextSessionId);
      } catch (error) {
        logWarn("session_bootstrap_failed", error);
      }
    };

    void boot();
    return () => {
      active = false;
      disposedRef.current = true;
      sessionIdRef.current = null;
      setSessionId(null);
    };
  }, [bootSession, fit]);

  return (
    <div className="terminal-only">
      <div ref={terminalNodeRef} className="terminal-root" />
    </div>
  );
}

export { createEmptyContext, mergeIncomingContext, syncEnvContextFromSnapshot, writeSnapshotScripts };
export { readTabSessionId, writeTabSessionId } from "./hooks/useSessionBootstrap.js";
