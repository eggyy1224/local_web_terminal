import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import type { EnvContext, SessionContext, WsClientMessage, WsServerMessage } from "@local-terminal/shared";

const GATEWAY_BASE = import.meta.env.VITE_GATEWAY_BASE ?? "http://127.0.0.1:8787";
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

function flattenSnapshot(payload: SidecarPayload): FlattenedSnapshot {
  const empty = createEmptyContext();
  return {
    ...empty,
    ...payload.context,
    twoPane: {
      ...empty.twoPane,
      ...(payload.context.twoPane ?? {}),
      codex: {
        ...empty.twoPane.codex,
        ...(payload.context.twoPane?.codex ?? {})
      },
      workspace: {
        ...empty.twoPane.workspace,
        ...(payload.context.twoPane?.workspace ?? {})
      }
    },
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
    twoPane: snapshot.twoPane,
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
  const contextTimerRef = useRef<number | null>(null);
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

    const refreshContext = async () => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        return;
      }

      try {
        const context = await api<SessionContext>(`/api/context/${sessionId}`);
        const mergedContext = {
          ...createEmptyContext(),
          ...context
        };
        latestContextRef.current = mergedContext;
        writeSnapshotScripts({
          context: mergedContext,
          updatedAt: Date.now(),
          envContext: latestEnvContextRef.current
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
    </div>
  );
}
