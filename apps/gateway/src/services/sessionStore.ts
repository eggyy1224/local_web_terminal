import type { SessionContext } from "@local-terminal/shared";
import { maskSensitive } from "@local-terminal/security";
import type { SessionState } from "../types.js";

const MAX_OUTPUT_CHUNKS = 400;
const MAX_COMMANDS = 80;

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  ensure(sessionId: string, activePane: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (activePane) {
        existing.activePane = activePane;
      }
      return existing;
    }

    const state: SessionState = {
      sessionId,
      activePane,
      outputChunks: [],
      lastCommands: [],
      currentInput: "",
      riskFlags: [],
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

  recordCommand(sessionId: string, command: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    const finalized = command.trim();
    if (!finalized) {
      return;
    }

    state.lastCommands.push(maskSensitive(finalized));
    if (state.lastCommands.length > MAX_COMMANDS) {
      state.lastCommands.splice(0, state.lastCommands.length - MAX_COMMANDS);
    }
  }

  setContext(sessionId: string, context: { cwd: string; shell: string; activePane: string }): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    state.cwd = context.cwd;
    state.shell = context.shell;
    state.activePane = context.activePane;
  }

  setRiskFlags(sessionId: string, riskFlags: string[]): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    state.riskFlags = [...new Set([...state.riskFlags, ...riskFlags])];
  }

  getContext(sessionId: string): SessionContext | null {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return null;
    }

    return {
      sessionId,
      activePane: state.activePane,
      cwd: state.cwd,
      shell: state.shell,
      recentOutput: state.outputChunks.slice(-50).map((chunk) => maskSensitive(chunk)),
      runningProcessHints: guessRunningProcesses(state.outputChunks),
      lastCommands: state.lastCommands.slice(-20),
      riskFlags: state.riskFlags.slice(-10)
    };
  }
}

function guessRunningProcesses(chunks: string[]): string[] {
  const last = chunks.slice(-30).join("\n").toLowerCase();
  const candidates = ["npm", "node", "pytest", "vitest", "pnpm", "git", "docker", "tmux", "python"];
  return candidates.filter((name) => last.includes(name));
}
