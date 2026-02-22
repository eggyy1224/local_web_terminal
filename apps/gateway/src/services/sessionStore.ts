import type { EnvContext, PaneView, SessionContext } from "@local-terminal/shared";
import { maskSensitive } from "@local-terminal/security";
import type { SessionState } from "../types.js";
import { extractRecentErrors } from "./contextCollector.js";

const MAX_OUTPUT_CHUNKS = 400;
const MAX_COMMANDS = 80;
const DEFAULT_SESSION_TTL_MS = Number.parseInt(process.env.SESSION_TTL_MS ?? "1800000", 10) || 1_800_000;

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  private mostRecentSessionId: string | null = null;
  private readonly sessionTtlMs: number;

  constructor(sessionTtlMs = DEFAULT_SESSION_TTL_MS) {
    this.sessionTtlMs = sessionTtlMs;
  }

  private clonePane(pane: PaneView): PaneView {
    return { ...pane, lines: [...pane.lines], errors: [...(pane.errors ?? [])] };
  }

  private getState(sessionId: string, options?: { touch?: boolean; markAsRecent?: boolean }): SessionState | null {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return null;
    }

    if (options?.markAsRecent) {
      this.mostRecentSessionId = sessionId;
    }

    if (options?.touch) {
      this.touchSession(sessionId);
    }

    return state;
  }

  private touchSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }
    state.lastSeenAt = Date.now();
  }

  private recomputeMostRecentSessionId(): void {
    let candidateSessionId: string | null = null;
    let bestLastSeenAt = -1;
    for (const [sessionId, state] of this.sessions) {
      if (state.lastSeenAt > bestLastSeenAt) {
        bestLastSeenAt = state.lastSeenAt;
        candidateSessionId = sessionId;
      }
    }
    this.mostRecentSessionId = candidateSessionId;
  }

  ensure(sessionId: string): SessionState {
    this.mostRecentSessionId = sessionId;
    const existing = this.getState(sessionId, { touch: true });
    if (existing) {
      return existing;
    }

    const state: SessionState = {
      sessionId,
      outputChunks: [],
      lastCommands: [],
      currentInput: "",
      shell: "zsh",
      cwd: process.cwd(),
      lastSeenAt: Date.now(),
      envProbeVersion: 0,
      paneInteractionById: {},
      latestPanes: []
    };

    this.sessions.set(sessionId, state);
    return state;
  }

  appendStdout(sessionId: string, chunk: string): void {
    const state = this.getState(sessionId, { touch: true, markAsRecent: true });
    if (!state) {
      return;
    }

    state.outputChunks.push(chunk);
    if (state.outputChunks.length > MAX_OUTPUT_CHUNKS) {
      state.outputChunks.splice(0, state.outputChunks.length - MAX_OUTPUT_CHUNKS);
    }
  }

  appendInput(sessionId: string, incoming: string): void {
    const state = this.getState(sessionId, { touch: true, markAsRecent: true });
    if (!state) {
      return;
    }

    for (const ch of incoming) {
      if (ch === "\u007f") {
        state.currentInput = state.currentInput.slice(0, -1);
        continue;
      }

      if (ch === "\r" || ch === "\n") {
        const finalized = state.currentInput.trim();
        if (finalized.length > 0) {
          state.lastCommands.push(maskSensitive(finalized));
          if (state.lastCommands.length > MAX_COMMANDS) {
            state.lastCommands.splice(0, state.lastCommands.length - MAX_COMMANDS);
          }
        }
        state.currentInput = "";
        continue;
      }

      if (ch >= " " && ch !== "\u001b") {
        state.currentInput += ch;
      }
    }
  }

  setContext(sessionId: string, context: { cwd: string; shell: string }): void {
    const state = this.getState(sessionId, { touch: true, markAsRecent: true });
    if (!state) {
      return;
    }

    state.cwd = context.cwd;
    state.shell = context.shell;
  }

  getContext(sessionId: string): SessionContext | null {
    const state = this.getState(sessionId, { touch: true });
    if (!state) {
      return null;
    }

    const recentOutput = state.outputChunks.slice(-50).map((chunk) => maskSensitive(chunk));
    const recentErrors = extractRecentErrors(recentOutput);

    return {
      timestamp: Date.now(),
      sessionId,
      cwd: state.cwd,
      repoRoot: "",
      branch: "",
      gitStatusPorcelain: "",
      diffStat: "",
      recentErrors,
      tmuxPanes: [],
      shell: state.shell,
      recentOutput,
      lastCommands: state.lastCommands.slice(-20),
      panes: state.latestPanes.map((pane) => this.clonePane(pane))
    };
  }

  getMostRecentSessionId(): string | null {
    return this.mostRecentSessionId;
  }

  nextEnvProbeVersion(sessionId: string): number {
    const state = this.getState(sessionId, { touch: true, markAsRecent: true });
    if (!state) {
      return 0;
    }

    state.envProbeVersion += 1;
    return state.envProbeVersion;
  }

  setLatestEnvContext(sessionId: string, env: EnvContext): void {
    const state = this.getState(sessionId, { touch: true, markAsRecent: true });
    if (!state) {
      return;
    }

    if (env.version < state.envProbeVersion) {
      return;
    }

    state.envProbeVersion = env.version;
    state.latestEnvContext = env;
  }

  getLatestEnvContext(sessionId: string): EnvContext | null {
    const state = this.getState(sessionId, { touch: true });
    if (!state?.latestEnvContext) {
      return null;
    }

    return state.latestEnvContext;
  }

  updatePaneInteraction(sessionId: string, paneId: string, interactedAt = Date.now()): void {
    const state = this.getState(sessionId, { touch: true, markAsRecent: true });
    if (!state || !paneId) {
      return;
    }

    state.paneInteractionById[paneId] = interactedAt;
  }

  getPaneInteraction(sessionId: string, paneId: string): number | null {
    const state = this.getState(sessionId, { touch: true });
    if (!state || !paneId) {
      return null;
    }

    return state.paneInteractionById[paneId] ?? null;
  }

  setLatestPanes(sessionId: string, panes: PaneView[]): void {
    const state = this.getState(sessionId, { touch: true, markAsRecent: true });
    if (!state) {
      return;
    }

    state.latestPanes = panes.map((pane) => this.clonePane(pane));
  }

  getLatestPanes(sessionId: string): PaneView[] {
    const state = this.getState(sessionId, { touch: true });
    if (!state) {
      return [];
    }

    return state.latestPanes.map((pane) => this.clonePane(pane));
  }

  release(sessionId: string): void {
    const removed = this.sessions.delete(sessionId);
    if (!removed) {
      return;
    }

    if (this.mostRecentSessionId === sessionId) {
      this.recomputeMostRecentSessionId();
    }
  }

  pruneExpiredSessions(now = Date.now()): string[] {
    const removed: string[] = [];
    let removedMostRecent = false;
    for (const [sessionId, state] of this.sessions) {
      if (now - state.lastSeenAt <= this.sessionTtlMs) {
        continue;
      }
      this.sessions.delete(sessionId);
      removed.push(sessionId);
      if (this.mostRecentSessionId === sessionId) {
        removedMostRecent = true;
      }
    }

    if (removedMostRecent) {
      this.recomputeMostRecentSessionId();
    }

    return removed;
  }
}
