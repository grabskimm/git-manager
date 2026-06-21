import { describe, it, expect, beforeAll } from "vitest";
import { isolateHome, initRepo, writeAndCommit, createBranch, checkout } from "./helpers.js";
import { attemptMerge, dryRunMerge } from "../src/merge.js";
import { revParse } from "../src/git.js";

beforeAll(() => {
  isolateHome();
});

describe("merge engine (§9)", () => {
  it("fast-forwards when base is an ancestor of head", async () => {
    const { path: repo } = await initRepo();
    await writeAndCommit(repo, "a.txt", "1", "c1");
    await createBranch(repo, "feature");
    const c2 = await writeAndCommit(repo, "b.txt", "2", "c2");

    const out = await attemptMerge(repo, "main", "feature", { deleteHeadOnMerge: false });
    expect(out.status).toBe("merged");
    if (out.status === "merged") {
      expect(out.fastForward).toBe(true);
      expect(out.mergeCommitSha).toBe(c2);
    }
    expect(await revParse(repo, "main")).toBe(c2);
  });

  it("creates a merge commit for diverged, non-conflicting branches", async () => {
    const { path: repo } = await initRepo();
    await writeAndCommit(repo, "a.txt", "base", "c1");
    await createBranch(repo, "feature");
    await writeAndCommit(repo, "feature.txt", "f", "c2");
    await checkout(repo, "main");
    const mainTip = await writeAndCommit(repo, "main.txt", "m", "c3");

    const out = await attemptMerge(repo, "main", "feature", { deleteHeadOnMerge: false });
    expect(out.status).toBe("merged");
    if (out.status === "merged") {
      expect(out.fastForward).toBe(false);
      expect(out.mergeCommitSha).not.toBe(mainTip);
    }
    // main moved to the new merge commit.
    expect(await revParse(repo, "main")).not.toBe(mainTip);
  });

  it("reports a conflict and leaves base untouched", async () => {
    const { path: repo } = await initRepo();
    const c1 = await writeAndCommit(repo, "f.txt", "base\n", "c1");
    await createBranch(repo, "feature");
    await writeAndCommit(repo, "f.txt", "feature\n", "c2");
    await checkout(repo, "main");
    const mainTip = await writeAndCommit(repo, "f.txt", "main\n", "c3");

    expect(await dryRunMerge(repo, "main", "feature")).toBe("conflict");

    const out = await attemptMerge(repo, "main", "feature", { deleteHeadOnMerge: false });
    expect(out.status).toBe("conflicted");
    if (out.status === "conflicted") {
      expect(out.conflictedFiles).toContain("f.txt");
    }
    // base branch must NOT have moved on conflict.
    expect(await revParse(repo, "main")).toBe(mainTip);
    expect(c1).toBeTruthy();
  });

  it("deletes the head branch on merge when requested", async () => {
    const { path: repo } = await initRepo();
    await writeAndCommit(repo, "a.txt", "1", "c1");
    await createBranch(repo, "feature");
    await writeAndCommit(repo, "b.txt", "2", "c2");
    await checkout(repo, "main");

    const out = await attemptMerge(repo, "main", "feature", { deleteHeadOnMerge: true });
    expect(out.status).toBe("merged");
    expect(await revParse(repo, "feature")).toBeNull();
  });
});
