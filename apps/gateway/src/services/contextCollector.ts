import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { PaneGitSnapshot, WorkspaceKind } from "@local-terminal/shared";

const execFileAsync = promisify(execFile);

interface ExecResult {
  stdout: string;
}

type ExecFn = (file: string, args: string[]) => Promise<ExecResult>;

interface GitSnapshotResult {
  branch: string;
  gitStatusPorcelain: string;
  diffStat: string;
  isDirty: boolean;
  summary: string | Record<string, unknown>;
}

interface GitSnapshot {
  repoRoot: string;
  branch: string;
  gitStatusPorcelain: string;
  diffStat: string;
}

export interface WorkspaceProbe {
  kind: WorkspaceKind;
  repoRoot: string;
}

async function runGit(cwd: string, args: string[], runner: ExecFn): Promise<string> {
  const result = await runner("git", ["-C", cwd, ...args]);
  return result.stdout.trim();
}

async function resolveBranch(cwd: string, runner: ExecFn): Promise<string> {
  try {
    return await runGit(cwd, ["symbolic-ref", "--short", "HEAD"], runner);
  } catch {
    try {
      const detached = await runGit(cwd, ["rev-parse", "--short", "HEAD"], runner);
      return detached ? `(detached:${detached})` : "";
    } catch {
      return "";
    }
  }
}

function countDiffStat(pattern: RegExp, diffStat: string): number {
  let total = 0;
  const matches = diffStat.matchAll(pattern);
  for (const item of matches) {
    total += Number.parseInt(item[1] ?? "0", 10) || 0;
  }
  return total;
}

export async function probeWorkspace(cwd: string, runner: ExecFn = execFileAsync): Promise<WorkspaceProbe> {
  if (!cwd) {
    return { kind: "unknown", repoRoot: "" };
  }

  try {
    const repoRoot = await runGit(cwd, ["rev-parse", "--show-toplevel"], runner);
    if (!repoRoot) {
      return { kind: "plain_dir", repoRoot: "" };
    }

    const normalizedRepoRoot = path.resolve(repoRoot);
    const normalizedCwd = path.resolve(cwd);
    const kind: WorkspaceKind =
      normalizedRepoRoot === normalizedCwd ? "git_repo_root" : "git_repo_subdir";

    return { kind, repoRoot: normalizedRepoRoot };
  } catch {
    return { kind: "plain_dir", repoRoot: "" };
  }
}

export async function collectGitSnapshotByRepoRoot(
  repoRoot: string,
  runner: ExecFn = execFileAsync
): Promise<GitSnapshotResult> {
  if (!repoRoot) {
    return {
      branch: "",
      gitStatusPorcelain: "",
      diffStat: "",
      isDirty: false,
      summary: ""
    };
  }

  const [branch, gitStatusPorcelain, staged, unstaged] = await Promise.all([
    resolveBranch(repoRoot, runner),
    runGit(repoRoot, ["status", "--porcelain=v1"], runner).catch(() => ""),
    runGit(repoRoot, ["diff", "--stat", "--cached", "--no-color"], runner).catch(() => ""),
    runGit(repoRoot, ["diff", "--stat", "--no-color"], runner).catch(() => "")
  ]);

  const diffStat = [unstaged, staged].filter(Boolean).join("\n").trim();
  const changedFiles = gitStatusPorcelain.split(/\r?\n/).filter(Boolean).length;
  const insertions = countDiffStat(/(\d+)\s+insertions?\(\+\)/g, diffStat);
  const deletions = countDiffStat(/(\d+)\s+deletions?\(-\)/g, diffStat);
  const isDirty = changedFiles > 0 || diffStat.length > 0;
  const summary: Record<string, unknown> = {
    changedFiles,
    insertions,
    deletions,
    diffStat
  };

  return {
    branch,
    gitStatusPorcelain,
    diffStat,
    isDirty,
    summary
  };
}

export async function collectGitSnapshot(cwd: string, runner: ExecFn = execFileAsync): Promise<GitSnapshot> {
  try {
    const workspace = await probeWorkspace(cwd, runner);
    if (!workspace.repoRoot) {
      return { repoRoot: "", branch: "", gitStatusPorcelain: "", diffStat: "" };
    }

    const gitSnapshot = await collectGitSnapshotByRepoRoot(workspace.repoRoot, runner);
    return {
      repoRoot: workspace.repoRoot,
      branch: gitSnapshot.branch,
      gitStatusPorcelain: gitSnapshot.gitStatusPorcelain,
      diffStat: gitSnapshot.diffStat
    };
  } catch {
    return { repoRoot: "", branch: "", gitStatusPorcelain: "", diffStat: "" };
  }
}

export function toPaneGitSnapshot(snapshot: GitSnapshotResult): PaneGitSnapshot {
  return {
    branch: snapshot.branch,
    isDirty: snapshot.isDirty,
    summary: snapshot.summary
  };
}

const CODEX_PATTERN = /\b(codex|chatgpt)\b/i;

export function isCodexPaneSignal(input: {
  currentCommand: string;
  title: string;
  lines?: string[];
}): boolean {
  if (CODEX_PATTERN.test(input.currentCommand)) {
    return true;
  }
  if (CODEX_PATTERN.test(input.title)) {
    return true;
  }
  if (!input.lines || input.lines.length === 0) {
    return false;
  }
  return input.lines.some((line) => CODEX_PATTERN.test(line));
}

const ERROR_PATTERN = /\b(error|failed|exception)\b/i;

export function extractRecentErrors(chunks: string[], limit = 20): string[] {
  const matched: string[] = [];
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const lines = chunks[i].split(/\r?\n/);
    for (let j = lines.length - 1; j >= 0; j -= 1) {
      const line = lines[j].trim();
      if (!line || !ERROR_PATTERN.test(line)) {
        continue;
      }
      matched.push(line);
      if (matched.length >= limit) {
        return matched.reverse();
      }
    }
  }

  return matched.reverse();
}
