import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import type { SessionContext, WsClientMessage, WsServerMessage } from "@local-terminal/shared";

const GATEWAY_BASE = import.meta.env.VITE_GATEWAY_BASE ?? "http://127.0.0.1:8787";
const STORAGE_SESSION_KEY = "local-web-terminal:session";

interface SidecarPayload {
  sessionId: string | null;
  context: SessionContext;
  updatedAt: number;
}

function serializeSnapshot(payload: SidecarPayload): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

function createEmptyContext(): SessionContext {
  return {
    timestamp: 0,
    sessionId: "",
    cwd: "",
    repoRoot: "",
    branch: "",
    gitStatusPorcelain: "",
    diffStat: "",
    recentErrors: [],
    tmuxPanes: [],
    shell: "",
    recentOutput: [],
    lastCommands: [],
    twoPane: {
      activePaneId: "",
      codex: {
        id: "",
        isActive: false,
        lines: [],
        role: "codex",
        errors: []
      },
      workspace: {
        id: "",
        isActive: false,
        lines: [],
        role: "workspace",
        workspaceKind: "unknown",
        gitSnapshot: null,
        errors: []
      }
    }
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GATEWAY_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API ${path} failed: ${body}`);
  }

  return response.json() as Promise<T>;
}

export function App() {
  const terminalNodeRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const contextTimerRef = useRef<number | null>(null);

  const [sidecar, setSidecar] = useState<SidecarPayload>({
    sessionId: null,
    context: createEmptyContext(),
    updatedAt: Date.now()
  });
  const serializedSidecar = serializeSnapshot(sidecar);

  useEffect(() => {
    if (!terminalNodeRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      fontFamily: "JetBrains Mono, SF Mono, Menlo, monospace",
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: "#0f1420",
        foreground: "#d4def8",
        cursor: "#f4b942",
        selectionBackground: "#214575"
      }
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(terminalNodeRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitRef.current = fitAddon;

    const refreshContext = async () => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        return;
      }

      try {
        const context = await api<SessionContext>(`/api/context/${sessionId}`);
        setSidecar({
          sessionId,
          context: {
            ...createEmptyContext(),
            ...context
          },
          updatedAt: Date.now()
        });
      } catch {
        // Keep terminal running even when context refresh fails.
      }
    };

    const connectWs = (sessionId: string) => {
      const base = GATEWAY_BASE.replace("http://", "ws://").replace("https://", "wss://");
      const ws = new WebSocket(`${base}/ws/sessions/${sessionId}/stream`);
      wsRef.current = ws;

      ws.onopen = () => {
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          const payload: WsClientMessage = {
            type: "resize",
            data: { cols: dims.cols, rows: dims.rows }
          };
          ws.send(JSON.stringify(payload));
        }
      };

      ws.onmessage = (event) => {
        const parsed = JSON.parse(event.data) as WsServerMessage;
        if (parsed.type === "stdout") {
          terminal.write(String(parsed.data));
        }
      };

      ws.onclose = () => {
        if (sessionIdRef.current !== sessionId) {
          return;
        }

        window.setTimeout(() => {
          if (sessionIdRef.current === sessionId) {
            connectWs(sessionId);
          }
        }, 1200);
      };
    };

    const createSession = async (): Promise<string> => {
      const dims = fitAddon.proposeDimensions();
      const created = await api<{ sessionId: string }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          cols: dims?.cols ?? 120,
          rows: dims?.rows ?? 35
        })
      });
      return created.sessionId;
    };

    const boot = async () => {
      let sessionId = window.localStorage.getItem(STORAGE_SESSION_KEY);
      if (!sessionId) {
        sessionId = await createSession();
        window.localStorage.setItem(STORAGE_SESSION_KEY, sessionId);
      }

      sessionIdRef.current = sessionId;
      setSidecar((prev) => ({
        ...prev,
        sessionId,
        context: {
          ...prev.context,
          sessionId
        },
        updatedAt: Date.now()
      }));
      connectWs(sessionId);
      await refreshContext();

      contextTimerRef.current = window.setInterval(() => {
        void refreshContext();
      }, 10000);
    };

    const onResize = () => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && wsRef.current?.readyState === WebSocket.OPEN) {
        const payload: WsClientMessage = {
          type: "resize",
          data: { cols: dims.cols, rows: dims.rows }
        };
        wsRef.current.send(JSON.stringify(payload));
      }
    };

    window.addEventListener("resize", onResize);

    terminal.onData((data) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        return;
      }
      const payload: WsClientMessage = { type: "stdin", data };
      wsRef.current.send(JSON.stringify(payload));
    });

    void boot();

    return () => {
      window.removeEventListener("resize", onResize);
      wsRef.current?.close();
      if (contextTimerRef.current !== null) {
        window.clearInterval(contextTimerRef.current);
      }
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  return (
    <div className="terminal-only">
      <div ref={terminalNodeRef} className="terminal-root" />
      <script
        id="snapshot-json"
        type="application/json"
        dangerouslySetInnerHTML={{ __html: serializedSidecar }}
      />
      <script
        id="ai-context-sidecar"
        type="application/json"
        data-alias-for="snapshot-json"
        dangerouslySetInnerHTML={{ __html: serializedSidecar }}
      />
    </div>
  );
}
