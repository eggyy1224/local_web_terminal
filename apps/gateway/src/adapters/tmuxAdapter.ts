import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PaneContext, PaneSnapshot, TerminalAdapter } from "../types.js";

const execFileAsync = promisify(execFile);

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
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

  async listPanes(sessionId: string): Promise<PaneSnapshot[]> {
    const clean = sanitizeSessionId(sessionId);
    const format = [
      "#{pane_id}",
      "#{pane_index}",
      "#{?pane_active,1,0}",
      "#{pane_title}",
      "#{pane_current_path}",
      "#{pane_current_command}"
    ].join("\u001f");
    const { stdout } = await execFileAsync(this.tmuxBin, ["list-panes", "-t", clean, "-F", format]);

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
