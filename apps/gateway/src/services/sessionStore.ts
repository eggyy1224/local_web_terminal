import type { EnvContext, PaneView, SessionContext } from "@local-terminal/shared";
import { maskSensitive } from "@local-terminal/security";
import type { SessionState } from "../types.js";
import { extractRecentErrors } from "./contextCollector.js";

const MAX_OUTPUT_CHUNKS = 400;
const MAX_COMMANDS = 80;

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  private mostRecentSessionId: string | null = null;

  ensure(sessionId: string): SessionState {
    this.mostRecentSessionId = sessionId;
    const existing = this.sessions.get(sessionId);
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
      envProbeVersion: 0,
      paneInteractionById: {},
      latestPanes: []
    };

    this.sessions.set(sessionId, state);
    return state;
  }

  appendStdout(sessionId: string, chunk: string): void {
    this.mostRecentSessionId = sessionId;
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    state.outputChunks.push(chunk);
    if (state.outputChunks.length > MAX_OUTPUT_CHUNKS) {
      state.outputChunks.splice(0, state.outputChunks.length - MAX_OUTPUT_CHUNKS);
    }
  }

  appendInput(sessionId: string, incoming: string): void {
    this.mostRecentSessionId = sessionId;
    const state = this.sessions.get(sessionId);
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
    this.mostRecentSessionId = sessionId;
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    state.cwd = context.cwd;
    state.shell = context.shell;
  }

  getContext(sessionId: string): SessionContext | null {
    const state = this.sessions.get(sessionId);
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
      panes: state.latestPanes.map((pane) => ({ ...pane, lines: [...pane.lines], errors: [...(pane.errors ?? [])] }))
    };
  }

  getMostRecentSessionId(): string | null {
    return this.mostRecentSessionId;
  }

  nextEnvProbeVersion(sessionId: string): number {
    this.mostRecentSessionId = sessionId;
    const state = this.sessions.get(sessionId);
    if (!state) {
      return 0;
    }

    state.envProbeVersion += 1;
    return state.envProbeVersion;
  }

  setLatestEnvContext(sessionId: string, env: EnvContext): void {
    this.mostRecentSessionId = sessionId;
    const state = this.sessions.get(sessionId);
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
    const state = this.sessions.get(sessionId);
    if (!state?.latestEnvContext) {
      return null;
    }

    return state.latestEnvContext;
  }

  updatePaneInteraction(sessionId: string, paneId: string, interactedAt = Date.now()): void {
    this.mostRecentSessionId = sessionId;
    const state = this.sessions.get(sessionId);
    if (!state || !paneId) {
      return;
    }

    state.paneInteractionById[paneId] = interactedAt;
  }

  getPaneInteraction(sessionId: string, paneId: string): number | null {
    const state = this.sessions.get(sessionId);
    if (!state || !paneId) {
      return null;
    }

    return state.paneInteractionById[paneId] ?? null;
  }

  setLatestPanes(sessionId: string, panes: PaneView[]): void {
    this.mostRecentSessionId = sessionId;
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    state.latestPanes = panes.map((pane) => ({ ...pane, lines: [...pane.lines], errors: [...(pane.errors ?? [])] }));
  }

  getLatestPanes(sessionId: string): PaneView[] {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return [];
    }
    return state.latestPanes;
  }
}
