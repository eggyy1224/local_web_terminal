import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ExecResult {
  stdout: string;
}

type ExecFn = (file: string, args: string[]) => Promise<ExecResult>;

interface GitSnapshot {
  repoRoot: string;
  branch: string;
  gitStatusPorcelain: string;
  diffStat: string;
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

export async function collectGitSnapshot(cwd: string, runner: ExecFn = execFileAsync): Promise<GitSnapshot> {
  try {
    const repoRoot = await runGit(cwd, ["rev-parse", "--show-toplevel"], runner);
    if (!repoRoot) {
      return { repoRoot: "", branch: "", gitStatusPorcelain: "", diffStat: "" };
    }

    const [branch, gitStatusPorcelain, staged, unstaged] = await Promise.all([
      resolveBranch(repoRoot, runner),
      runGit(repoRoot, ["status", "--porcelain=v1", "-b"], runner).catch(() => ""),
      runGit(repoRoot, ["diff", "--stat", "--no-color"], runner).catch(() => ""),
      runGit(repoRoot, ["diff", "--stat", "--cached", "--no-color"], runner).catch(() => "")
    ]);

    const diffStat = [unstaged, staged].filter(Boolean).join("\n").trim();
    return {
      repoRoot,
      branch,
      gitStatusPorcelain,
      diffStat
    };
  } catch {
    return { repoRoot: "", branch: "", gitStatusPorcelain: "", diffStat: "" };
  }
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
