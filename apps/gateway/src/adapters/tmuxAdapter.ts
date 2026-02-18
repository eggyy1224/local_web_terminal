import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SplitDirection, TmuxTopology } from "@local-terminal/shared";
import type { PaneContext, TerminalAdapter } from "../types.js";

const execFileAsync = promisify(execFile);

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function parsePaneList(raw: string, sessionId: string): TmuxTopology {
  const panes = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sessionName, windowId, windowName, paneId, paneActive, paneTitle] = line.split("|");
      return {
        sessionName,
        windowId,
        windowName,
        paneId,
        paneActive,
        paneTitle
      };
    })
    .filter((pane) => pane.sessionName === sessionId);

  const windowMap = new Map<string, { windowId: string; windowName: string; panes: TmuxTopology["windows"][0]["panes"] }>();

  let activePaneId = "";

  for (const pane of panes) {
    if (!windowMap.has(pane.windowId)) {
      windowMap.set(pane.windowId, {
        windowId: pane.windowId,
        windowName: pane.windowName,
        panes: []
      });
    }

    const isActive = pane.paneActive === "1";
    if (isActive) {
      activePaneId = pane.paneId;
    }

    windowMap.get(pane.windowId)?.panes.push({
      paneId: pane.paneId,
      windowId: pane.windowId,
      title: pane.paneTitle || "shell",
      isActive
    });
  }

  return {
    sessionId,
    windows: [...windowMap.values()],
    activePaneId
  };
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

  async createTab(sessionId: string): Promise<{ activePaneId: string }> {
    const clean = sanitizeSessionId(sessionId);
    const { stdout } = await execFileAsync(this.tmuxBin, ["new-window", "-t", clean, "-P", "-F", "#{pane_id}"]);
    return { activePaneId: stdout.trim() };
  }

  async splitPane(sessionId: string, direction: SplitDirection): Promise<{ paneId: string }> {
    const clean = sanitizeSessionId(sessionId);
    const splitFlag = direction === "vertical" ? "-h" : "-v";
    const { stdout } = await execFileAsync(this.tmuxBin, [
      "split-window",
      splitFlag,
      "-t",
      clean,
      "-P",
      "-F",
      "#{pane_id}"
    ]);
    return { paneId: stdout.trim() };
  }

  async listTopology(sessionId: string): Promise<TmuxTopology> {
    const clean = sanitizeSessionId(sessionId);
    const { stdout } = await execFileAsync(this.tmuxBin, [
      "list-panes",
      "-a",
      "-t",
      `${clean}:`,
      "-F",
      "#{session_name}|#{window_id}|#{window_name}|#{pane_id}|#{pane_active}|#{pane_title}"
    ]);
    return parsePaneList(stdout, clean);
  }

  async selectPane(sessionId: string, paneId: string): Promise<void> {
    void sessionId;
    await execFileAsync(this.tmuxBin, ["select-pane", "-t", paneId]);
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

  async sendCommandToActivePane(sessionId: string, command: string): Promise<{ paneId: string }> {
    const paneId = await this.getActivePane(sessionId);
    await execFileAsync(this.tmuxBin, ["send-keys", "-t", paneId, command, "C-m"]);
    return { paneId };
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
}

export function attachCommand(sessionId: string): { file: string; args: string[] } {
  return {
    file: process.env.TMUX_BIN ?? "tmux",
    args: ["-u", "attach-session", "-t", sanitizeSessionId(sessionId)]
  };
}
