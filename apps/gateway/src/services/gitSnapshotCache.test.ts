import { describe, expect, it, vi } from "vitest";
import { createGitSnapshotReader } from "./gitSnapshotCache.js";

type SnapshotResult = {
  branch: string;
  gitStatusPorcelain: string;
  diffStat: string;
  isDirty: boolean;
  summary: string;
};

describe("createGitSnapshotReader", () => {
  it("reuses cached snapshot within ttl", async () => {
    let now = 1_000;
    const collectSnapshot = vi.fn(async () => ({
      branch: "main",
      gitStatusPorcelain: "",
      diffStat: "",
      isDirty: false,
      summary: ""
    }));

    const readGitByRepoRoot = createGitSnapshotReader({
      ttlMs: 1_000,
      now: () => now,
      collectSnapshot
    });

    const paneErrors: string[] = [];
    const first = await readGitByRepoRoot("/repo", paneErrors, "%1");
    now += 500;
    const second = await readGitByRepoRoot("/repo", paneErrors, "%2");

    expect(first).toEqual(second);
    expect(collectSnapshot).toHaveBeenCalledTimes(1);
    expect(paneErrors).toHaveLength(0);
  });

  it("refreshes snapshot after ttl expires", async () => {
    let now = 1_000;
    const collectSnapshot = vi
      .fn<(repoRoot: string) => Promise<SnapshotResult>>()
      .mockResolvedValueOnce({
        branch: "main",
        gitStatusPorcelain: "",
        diffStat: "",
        isDirty: false,
        summary: ""
      })
      .mockResolvedValueOnce({
        branch: "feature",
        gitStatusPorcelain: " M file.txt",
        diffStat: " file.txt | 1 +",
        isDirty: true,
        summary: ""
      });

    const readGitByRepoRoot = createGitSnapshotReader({
      ttlMs: 200,
      now: () => now,
      collectSnapshot
    });

    const first = await readGitByRepoRoot("/repo", [], "%1");
    now += 250;
    const second = await readGitByRepoRoot("/repo", [], "%1");

    expect(first?.branch).toBe("main");
    expect(second?.branch).toBe("feature");
    expect(collectSnapshot).toHaveBeenCalledTimes(2);
  });
});
