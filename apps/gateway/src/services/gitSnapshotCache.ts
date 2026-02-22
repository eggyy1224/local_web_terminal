import { collectGitSnapshotByRepoRoot } from "./contextCollector.js";
import { paneError } from "./contextErrorCollector.js";

type GitSnapshot = Awaited<ReturnType<typeof collectGitSnapshotByRepoRoot>>;

interface CachedGitSnapshotResult {
  snapshot: GitSnapshot | null;
  error: unknown | null;
}

interface CacheEntry {
  value: GitSnapshot;
  expiresAt: number;
}

interface CreateGitSnapshotReaderOptions {
  ttlMs?: number;
  now?: () => number;
  collectSnapshot?: typeof collectGitSnapshotByRepoRoot;
}

export type ReadGitByRepoRoot = (
  repoRoot: string,
  paneErrors: string[],
  paneId: string
) => Promise<GitSnapshot | null>;

const parsedGitSnapshotCacheTtlMs = Number.parseInt(process.env.GIT_SNAPSHOT_CACHE_TTL_MS ?? "1200", 10);
const DEFAULT_GIT_SNAPSHOT_CACHE_TTL_MS = Number.isNaN(parsedGitSnapshotCacheTtlMs)
  ? 1200
  : parsedGitSnapshotCacheTtlMs;

export function createGitSnapshotReader(options: CreateGitSnapshotReaderOptions = {}): ReadGitByRepoRoot {
  const ttlMs = options.ttlMs ?? DEFAULT_GIT_SNAPSHOT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const collectSnapshot = options.collectSnapshot ?? collectGitSnapshotByRepoRoot;
  const cache = new Map<string, Promise<CachedGitSnapshotResult>>();
  const values = new Map<string, CacheEntry>();

  return async (repoRoot, paneErrors, paneId) => {
    if (!repoRoot) {
      return null;
    }

    const cached = values.get(repoRoot);
    if (cached && cached.expiresAt > now()) {
      return cached.value;
    }

    if (cached) {
      values.delete(repoRoot);
    }

    let inFlight = cache.get(repoRoot);
    if (!inFlight) {
      inFlight = collectSnapshot(repoRoot)
        .then((snapshot) => ({ snapshot, error: null }))
        .catch((error: unknown) => ({ snapshot: null, error }));
      cache.set(repoRoot, inFlight);
    }

    const result = await inFlight;
    cache.delete(repoRoot);
    if (result.error) {
      paneErrors.push(paneError("git_snapshot_failed", result.error, paneId));
      return null;
    }

    if (result.snapshot && ttlMs > 0) {
      values.set(repoRoot, {
        value: result.snapshot,
        expiresAt: now() + ttlMs
      });
    }

    return result.snapshot;
  };
}
