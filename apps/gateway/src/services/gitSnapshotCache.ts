import { collectGitSnapshotByRepoRoot } from "./contextCollector.js";
import { paneError } from "./contextErrorCollector.js";

type GitSnapshot = Awaited<ReturnType<typeof collectGitSnapshotByRepoRoot>>;

interface CachedGitSnapshotResult {
  snapshot: GitSnapshot | null;
  error: unknown | null;
}

export type ReadGitByRepoRoot = (
  repoRoot: string,
  paneErrors: string[],
  paneId: string
) => Promise<GitSnapshot | null>;

export function createGitSnapshotReader(): ReadGitByRepoRoot {
  const cache = new Map<string, Promise<CachedGitSnapshotResult>>();

  return async (repoRoot, paneErrors, paneId) => {
    if (!repoRoot) {
      return null;
    }

    let inFlight = cache.get(repoRoot);
    if (!inFlight) {
      inFlight = collectGitSnapshotByRepoRoot(repoRoot)
        .then((snapshot) => ({ snapshot, error: null }))
        .catch((error: unknown) => ({ snapshot: null, error }));
      cache.set(repoRoot, inFlight);
    }

    const result = await inFlight;
    if (result.error) {
      paneErrors.push(paneError("git_snapshot_failed", result.error, paneId));
      return null;
    }

    return result.snapshot;
  };
}
