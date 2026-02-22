import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertRawTmuxTarget, normalizeUpstreamPaneTarget } from "../services/paneTargetNormalizer.js";
import type { ActiveEnvironmentProbe, PaneContext, PaneSnapshot, TerminalAdapter } from "../types.js";

const execFileAsync = promisify(execFile);
const PROBE_EXEC_TIMEOUT_MS = Number.parseInt(process.env.ENV_PROBE_TIMEOUT_MS ?? "800", 10) || 800;
const TMUX_FIELD_SEPARATOR = "\u001f";
const TMUX_ESCAPED_FIELD_SEPARATOR = "\\037";

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

function splitTmuxFields(value: string, expectedFields?: number): string[] {
  if (value.includes(TMUX_FIELD_SEPARATOR)) {
    return value
      .split(TMUX_FIELD_SEPARATOR)
      .map((field) => field.replaceAll(TMUX_ESCAPED_FIELD_SEPARATOR, TMUX_FIELD_SEPARATOR));
  }

  if (!value.includes(TMUX_ESCAPED_FIELD_SEPARATOR)) {
    return [value];
  }

  const delimiter = TMUX_ESCAPED_FIELD_SEPARATOR;
  const escapedDelimiter = `\\${TMUX_ESCAPED_FIELD_SEPARATOR}`;
  const fields: string[] = [];
  let buffer = "";
  let index = 0;

  while (index < value.length) {
    if (value.startsWith(escapedDelimiter, index)) {
      buffer += TMUX_FIELD_SEPARATOR;
      index += escapedDelimiter.length;
      continue;
    }

    if (value.startsWith(delimiter, index)) {
      fields.push(buffer);
      buffer = "";
      index += delimiter.length;
      continue;
    }

    buffer += value[index] ?? "";
    index += 1;
  }

  fields.push(buffer);
  if (expectedFields && fields.length !== expectedFields) {
    return [value];
  }

  return fields;
}

export function normalizeTmuxPaneTarget(rawTarget: string): string {
  return assertRawTmuxTarget(rawTarget);
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
    return normalizeTmuxPaneTarget(stdout);
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

    const candidates = Array.from(new Set([target, clean].map((item) => item.trim()).filter(Boolean)));
    let probe:
      | {
          tmuxSession: string;
          tmuxWindow: string;
          activePaneId: string;
          tmuxPane: string;
          paneCurrentPath: string;
          paneCurrentCommand: string;
          paneTitle: string;
        }
      | null = null;
    let lastError: unknown = null;

    for (const candidate of candidates) {
      try {
        const { stdout } = await execFileAsync(
          this.tmuxBin,
          ["display-message", "-p", "-t", candidate, format],
          { timeout: PROBE_EXEC_TIMEOUT_MS, maxBuffer: 128 * 1024 }
        );

        const [clientSession, sessionName, tmuxWindow, activePaneId, tmuxPane, paneCurrentPath, paneCurrentCommand, paneTitle] =
          splitTmuxFields(stdout.trim(), 8);
        const tmuxSession = (sessionName ?? "").trim() || (clientSession ?? "").trim();
        const normalizedActivePaneId =
          activePaneId && activePaneId.trim().length > 0
            ? normalizeTmuxPaneTarget(normalizeUpstreamPaneTarget(activePaneId))
            : "";
        const normalizedTmuxWindow = (tmuxWindow ?? "").trim();
        const normalizedTmuxPane = (tmuxPane ?? "").trim();
        const hasIdentity = Boolean(tmuxSession || normalizedTmuxWindow || normalizedTmuxPane || normalizedActivePaneId);
        if (!hasIdentity) {
          continue;
        }

        probe = {
          tmuxSession,
          tmuxWindow: normalizedTmuxWindow,
          activePaneId: normalizedActivePaneId,
          tmuxPane: normalizedTmuxPane,
          paneCurrentPath: (paneCurrentPath ?? "").trim(),
          paneCurrentCommand: (paneCurrentCommand ?? "").trim(),
          paneTitle: (paneTitle ?? "").trim()
        };
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!probe) {
      if (lastError) {
        throw lastError;
      }
      throw new Error(`tmux env probe returned empty identity for session=${clean}`);
    }

    const realCwd = probe.paneCurrentPath;
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
      activePaneId: probe.activePaneId,
      paneCurrentPath: realCwd,
      paneCurrentCommand: probe.paneCurrentCommand,
      paneTitle: probe.paneTitle,
      tmux: {
        session: probe.tmuxSession,
        window: probe.tmuxWindow,
        pane: probe.tmuxPane
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
        const [id, indexRaw, activeRaw, title, currentPath, currentCommand] = splitTmuxFields(line, 6);
        return {
          id: normalizeTmuxPaneTarget(normalizeUpstreamPaneTarget(id ?? "")),
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
    const tmuxTarget = normalizeTmuxPaneTarget(normalizeUpstreamPaneTarget(paneId));
    try {
      const { stdout } = await execFileAsync(this.tmuxBin, [
        "capture-pane",
        "-p",
        "-t",
        tmuxTarget,
        "-S",
        `-${captureStart}`
      ]);
      return normalizeCapturedLines(stdout);
    } catch (error) {
      const details = `tmux capture-pane -p -t ${tmuxTarget} -S -${captureStart}`;
      throw new Error(
        `tmux capture-pane failed for session=${sessionId} sourcePaneId=${JSON.stringify(paneId)} cmd=${details}`,
        { cause: error }
      );
    }
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
    const candidates = Array.from(new Set([probeTarget?.trim() || "", cleanSessionId].filter(Boolean)));
    let lastError: unknown = null;
    for (const target of candidates) {
      try {
        const { stdout } = await execFileAsync(this.tmuxBin, [
          "display-message",
          "-p",
          "-t",
          target,
          "#{window_id}"
        ]);
        const windowId = stdout.trim();
        if (windowId.length > 0) {
          return windowId;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error(`tmux active window unavailable for session=${cleanSessionId}`);
  }
}

export function attachCommand(sessionId: string): { file: string; args: string[] } {
  return {
    file: process.env.TMUX_BIN ?? "tmux",
    args: ["-u", "attach-session", "-t", sanitizeSessionId(sessionId)]
  };
}
