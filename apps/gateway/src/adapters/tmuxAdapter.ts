import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActiveEnvironmentProbe, PaneContext, PaneSnapshot, TerminalAdapter } from "../types.js";

const execFileAsync = promisify(execFile);
const PROBE_EXEC_TIMEOUT_MS = Number.parseInt(process.env.ENV_PROBE_TIMEOUT_MS ?? "180", 10) || 180;

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeCapturedLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export class TmuxAdapter implements TerminalAdapter {
  private readonly tmuxBin: string;

  constructor(tmuxBin = process.env.TMUX_BIN ?? "tmux") {
    this.tmuxBin = tmuxBin;
  }

  async createSession(sessionId: string, cols: number, rows: number): Promise<{ activePaneId: string }> {
    const clean = sanitizeSessionId(sessionId);
    const exists = await this.ensureSessionExists(clean);
    if (!exists) {
      await execFileAsync(this.tmuxBin, [
        "new-session",
        "-d",
        "-s",
        clean,
        "-x",
        String(cols),
        "-y",
        String(rows)
      ]);
    }

    const activePaneId = await this.getActivePane(clean);
    return { activePaneId };
  }

  async getActivePane(sessionId: string): Promise<string> {
    const clean = sanitizeSessionId(sessionId);
    const { stdout } = await execFileAsync(this.tmuxBin, ["display-message", "-p", "-t", clean, "#{pane_id}"]);
    return stdout.trim();
  }

  async getPaneContext(sessionId: string): Promise<PaneContext> {
    const clean = sanitizeSessionId(sessionId);
    const [cwdRes, shellRes] = await Promise.all([
      execFileAsync(this.tmuxBin, ["display-message", "-p", "-t", clean, "#{pane_current_path}"]),
      execFileAsync(this.tmuxBin, ["display-message", "-p", "-t", clean, "#{pane_current_command}"])
    ]);

    return {
      cwd: cwdRes.stdout.trim(),
      shell: shellRes.stdout.trim()
    };
  }

  async probeActiveEnvironment(sessionId: string, probeTarget?: string): Promise<ActiveEnvironmentProbe> {
    const clean = sanitizeSessionId(sessionId);
    const target = probeTarget?.trim() || clean;
    const format = [
      "#{client_session}",
      "#{session_name}",
      "#{window_index}",
      "#{pane_id}",
      "#{pane_index}",
      "#{pane_current_path}",
      "#{pane_current_command}",
      "#{pane_title}"
    ].join("\u001f");

    const { stdout } = await execFileAsync(
      this.tmuxBin,
      ["display-message", "-p", "-t", target, format],
      { timeout: PROBE_EXEC_TIMEOUT_MS, maxBuffer: 128 * 1024 }
    );

    const [clientSession, sessionName, tmuxWindow, activePaneId, tmuxPane, paneCurrentPath, paneCurrentCommand, paneTitle] =
      stdout.trim().split("\u001f");
    const tmuxSession = (clientSession ?? "").trim() || (sessionName ?? "").trim();

    const realCwd = (paneCurrentPath ?? "").trim();
    let repoRoot = "";
    let isGitRepo = false;

    if (realCwd) {
      try {
        const repo = await execFileAsync("git", ["-C", realCwd, "rev-parse", "--show-toplevel"], {
          timeout: PROBE_EXEC_TIMEOUT_MS,
          maxBuffer: 64 * 1024
        });
        repoRoot = repo.stdout.trim();
        isGitRepo = repoRoot.length > 0;
      } catch {
        repoRoot = "";
        isGitRepo = false;
      }
    }

    return {
      activePaneId: (activePaneId ?? "").trim(),
      paneCurrentPath: realCwd,
      paneCurrentCommand: (paneCurrentCommand ?? "").trim(),
      paneTitle: (paneTitle ?? "").trim(),
      tmux: {
        session: tmuxSession,
        window: (tmuxWindow ?? "").trim(),
        pane: (tmuxPane ?? "").trim()
      },
      repoRoot,
      isGitRepo
    };
  }

  async listPanes(sessionId: string, probeTarget?: string): Promise<PaneSnapshot[]> {
    const clean = sanitizeSessionId(sessionId);
    const targetWindow = await this.getActiveWindow(clean, probeTarget);
    const format = [
      "#{pane_id}",
      "#{pane_index}",
      "#{?pane_active,1,0}",
      "#{pane_title}",
      "#{pane_current_path}",
      "#{pane_current_command}"
    ].join("\u001f");
    const { stdout } = await execFileAsync(this.tmuxBin, ["list-panes", "-t", targetWindow, "-F", format]);

    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, indexRaw, activeRaw, title, currentPath, currentCommand] = line.split("\u001f");
        return {
          id: id ?? "",
          index: Number.parseInt(indexRaw ?? "0", 10) || 0,
          active: activeRaw === "1",
          title: title ?? "",
          currentPath: currentPath ?? "",
          currentCommand: currentCommand ?? ""
        };
      });
  }

  async capturePaneLines(sessionId: string, paneId: string, limit: number): Promise<string[]> {
    const captureStart = Math.max(0, limit - 1);
    const { stdout } = await execFileAsync(this.tmuxBin, [
      "capture-pane",
      "-p",
      "-t",
      paneId,
      "-S",
      `-${captureStart}`
    ]);
    return normalizeCapturedLines(stdout);
  }

  async ensureSessionExists(sessionId: string): Promise<boolean> {
    const clean = sanitizeSessionId(sessionId);
    try {
      await execFileAsync(this.tmuxBin, ["has-session", "-t", clean]);
      return true;
    } catch {
      return false;
    }
  }

  private async getActiveWindow(cleanSessionId: string, probeTarget?: string): Promise<string> {
    const target = probeTarget?.trim() || cleanSessionId;
    const { stdout } = await execFileAsync(this.tmuxBin, [
      "display-message",
      "-p",
      "-t",
      target,
      "#{window_id}"
    ]);
    return stdout.trim();
  }
}

export function attachCommand(sessionId: string): { file: string; args: string[] } {
  return {
    file: process.env.TMUX_BIN ?? "tmux",
    args: ["-u", "attach-session", "-t", sanitizeSessionId(sessionId)]
  };
}
