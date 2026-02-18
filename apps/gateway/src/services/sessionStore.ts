import type { SessionContext } from "@local-terminal/shared";
import { maskSensitive } from "@local-terminal/security";
import type { SessionState } from "../types.js";
import { extractRecentErrors } from "./contextCollector.js";

const MAX_OUTPUT_CHUNKS = 400;
const MAX_COMMANDS = 80;

function emptyTwoPaneSnapshot() {
  return {
    activePaneId: "",
    codex: {
      id: "",
      isActive: false,
      lines: [],
      role: "codex" as const,
      errors: []
    },
    workspace: {
      id: "",
      isActive: false,
      lines: [],
      role: "workspace" as const,
      workspaceKind: "unknown" as const,
      gitSnapshot: null,
      errors: []
    }
  };
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  ensure(sessionId: string): SessionState {
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
      cwd: process.cwd()
    };

    this.sessions.set(sessionId, state);
    return state;
  }

  appendStdout(sessionId: string, chunk: string): void {
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
      twoPane: emptyTwoPaneSnapshot()
    };
  }
}
