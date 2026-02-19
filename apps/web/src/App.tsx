import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import type { EnvContext, SessionContext, WsClientMessage, WsServerMessage } from "@local-terminal/shared";

const GATEWAY_BASE = import.meta.env.VITE_GATEWAY_BASE ?? "http://127.0.0.1:8787";
const CONTEXT_BOOTSTRAP_TIMEOUT_MS =
  Number.parseInt(
    String(import.meta.env.VITE_CONTEXT_BOOTSTRAP_TIMEOUT_MS ?? import.meta.env.CONTEXT_BOOTSTRAP_TIMEOUT_MS ?? "1500"),
    10
  ) || 1500;
const STORAGE_SESSION_KEY = "local-web-terminal:session";

interface SidecarPayload {
  context: SessionContext;
  updatedAt: number;
  envContext?: EnvContext | null;
}

interface SnapshotScriptNode {
  textContent: string | null;
}

interface SnapshotWriterDocument {
  querySelector(selector: string): SnapshotScriptNode | null;
}

interface FlattenedSnapshot extends SessionContext {
  updatedAt: number;
}

type SessionStorageReader = Pick<Storage, "getItem">;
type SessionStorageWriter = Pick<Storage, "setItem">;

export function readTabSessionId(storage?: SessionStorageReader): string | null {
  const target = storage ?? (typeof window !== "undefined" ? window.sessionStorage : null);
  if (!target) {
    return null;
  }
  return target.getItem(STORAGE_SESSION_KEY);
}

export function writeTabSessionId(sessionId: string, storage?: SessionStorageWriter): void {
  const target = storage ?? (typeof window !== "undefined" ? window.sessionStorage : null);
  if (!target) {
    return;
  }
  target.setItem(STORAGE_SESSION_KEY, sessionId);
}

export function createEmptyContext(): SessionContext {
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
    panes: []
  };
}

export function mergeIncomingContext(context: SessionContext): SessionContext {
  return {
    ...createEmptyContext(),
    ...context
  };
}

function flattenSnapshot(payload: SidecarPayload): FlattenedSnapshot {
  const empty = createEmptyContext();
  const panes = Array.isArray(payload.context.panes) ? payload.context.panes : [];
  return {
    ...empty,
    ...payload.context,
    panes: panes.map((pane) => ({
      ...pane,
      lines: Array.isArray(pane.lines) ? pane.lines : [],
      errors: Array.isArray(pane.errors) ? pane.errors : []
    })),
    updatedAt: payload.updatedAt
  };
}

function serializeSnapshot(snapshot: FlattenedSnapshot): string {
  return JSON.stringify(snapshot).replace(/</g, "\\u003c");
}

function formatEnvContext(env: EnvContext): string {
  return [
    "[ENV_CONTEXT]",
    `activePaneId: ${env.activePaneId}`,
    `role: ${env.role}`,
    `real_cwd: ${env.realCwd}`,
    `repo_root: ${env.repoRoot}`,
    `is_git_repo: ${String(env.isGitRepo)}`,
    `tmux: session=${env.tmux.session} window=${env.tmux.window} pane=${env.tmux.pane}`,
    "[/ENV_CONTEXT]"
  ].join("\n");
}

function serializeAiSnapshot(snapshot: FlattenedSnapshot, envContext: EnvContext | null): string {
  return JSON.stringify({
    sessionId: snapshot.sessionId,
    timestamp: snapshot.timestamp,
    recentErrors: snapshot.recentErrors,
    panes: snapshot.panes,
    envContext,
    envContextText: envContext ? formatEnvContext(envContext) : ""
  }).replace(/</g, "\\u003c");
}

export function writeSnapshotScripts(payload: SidecarPayload, doc: SnapshotWriterDocument = document): void {
  const flattened = flattenSnapshot(payload);
  const serialized = serializeSnapshot(flattened);
  const serializedAi = serializeAiSnapshot(flattened, payload.envContext ?? null);
  const primary = doc.querySelector("script#snapshot-json[type='application/json']");
  if (primary) {
    primary.textContent = serialized;
  }

  const alias = doc.querySelector("script#ai-context-sidecar[type='application/json']");
  if (alias) {
    alias.textContent = serialized;
  }

  const aiSnapshot = doc.querySelector("#ai-snapshot");
  if (aiSnapshot) {
    aiSnapshot.textContent = serializedAi;
  }
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
  const bootstrapTimerRef = useRef<number | null>(null);
  const latestContextRef = useRef<SessionContext>(createEmptyContext());
  const latestEnvContextRef = useRef<EnvContext | null>(null);

  useEffect(() => {
    latestContextRef.current = createEmptyContext();
    latestEnvContextRef.current = null;
    writeSnapshotScripts({
      context: createEmptyContext(),
      updatedAt: Date.now(),
      envContext: null
    });
  }, []);

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

    const clearBootstrapTimer = () => {
      if (bootstrapTimerRef.current !== null) {
        window.clearTimeout(bootstrapTimerRef.current);
        bootstrapTimerRef.current = null;
      }
    };

    const refreshContext = async (sessionIdHint?: string) => {
      const sessionId = sessionIdHint ?? sessionIdRef.current;
      if (!sessionId) {
        return false;
      }

      try {
        const context = await api<SessionContext>(`/api/context/${sessionId}`);
        const mergedContext = mergeIncomingContext(context);
        latestContextRef.current = mergedContext;
        writeSnapshotScripts({
          context: mergedContext,
          updatedAt: Date.now(),
          envContext: latestEnvContextRef.current
        });
        return true;
      } catch {
        // Keep terminal running even when context refresh fails.
        return false;
      }
    };

    const connectWs = (sessionId: string) => {
      const base = GATEWAY_BASE.replace("http://", "ws://").replace("https://", "wss://");
      const ws = new WebSocket(`${base}/ws/sessions/${sessionId}/stream`);
      wsRef.current = ws;
      let hasReceivedContextSnapshot = false;

      ws.onopen = () => {
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          const payload: WsClientMessage = {
            type: "resize",
            data: { cols: dims.cols, rows: dims.rows }
          };
          ws.send(JSON.stringify(payload));
        }

        clearBootstrapTimer();
        bootstrapTimerRef.current = window.setTimeout(() => {
          if (sessionIdRef.current !== sessionId || hasReceivedContextSnapshot) {
            return;
          }
          void refreshContext(sessionId);
        }, CONTEXT_BOOTSTRAP_TIMEOUT_MS);
      };

      ws.onmessage = (event) => {
        const parsed = JSON.parse(event.data) as WsServerMessage;
        if (parsed.type === "stdout") {
          terminal.write(String(parsed.data));
          return;
        }

        if (parsed.type === "meta" && parsed.data.kind === "context_snapshot") {
          hasReceivedContextSnapshot = true;
          clearBootstrapTimer();
          const mergedContext = mergeIncomingContext(parsed.data.snapshot);
          latestContextRef.current = mergedContext;
          writeSnapshotScripts({
            context: mergedContext,
            updatedAt: parsed.data.updatedAt,
            envContext: latestEnvContextRef.current
          });
          return;
        }

        if (parsed.type === "meta" && parsed.data.kind === "env_probe") {
          const incoming = parsed.data.env;
          const current = latestEnvContextRef.current;
          if (!current || incoming.version >= current.version) {
            latestEnvContextRef.current = incoming;
            writeSnapshotScripts({
              context: latestContextRef.current,
              updatedAt: Date.now(),
              envContext: incoming
            });
          }
        }
      };

      ws.onclose = () => {
        clearBootstrapTimer();
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
      let sessionId = readTabSessionId();
      if (!sessionId) {
        sessionId = await createSession();
        writeTabSessionId(sessionId);
      }

      sessionIdRef.current = sessionId;
      latestContextRef.current = {
        ...createEmptyContext(),
        sessionId
      };
      writeSnapshotScripts({
        context: latestContextRef.current,
        updatedAt: Date.now(),
        envContext: latestEnvContextRef.current
      });
      connectWs(sessionId);
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
      clearBootstrapTimer();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  return (
    <div className="terminal-only">
      <div ref={terminalNodeRef} className="terminal-root" />
    </div>
  );
}
