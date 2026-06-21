import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runGit, git, revParse, branchExists } from "./git.js";

export type MergeOutcome =
  | { status: "merged"; mergeCommitSha: string; fastForward: boolean }
  | { status: "conflicted"; conflictedFiles: string[] }
  | { status: "error"; message: string };

/**
 * Attempt a clean merge of `headRef` into `baseRef` using a throwaway detached
 * worktree, so the user's checkouts are never disturbed. Fast-forwards when
 * possible, otherwise creates a merge commit. On conflict, aborts cleanly and
 * reports the conflicted files. We never hand-roll merge logic — system git
 * does the work.
 */
export async function attemptMerge(
  repoPath: string,
  baseRef: string,
  headRef: string,
  opts: { deleteHeadOnMerge: boolean } = { deleteHeadOnMerge: false },
): Promise<MergeOutcome> {
  if (!(await branchExists(repoPath, baseRef))) {
    return { status: "error", message: `base branch "${baseRef}" does not exist` };
  }
  const baseSha = await revParse(repoPath, baseRef);
  const headSha = await revParse(repoPath, headRef);
  if (!baseSha) return { status: "error", message: `cannot resolve base "${baseRef}"` };
  if (!headSha) return { status: "error", message: `cannot resolve head "${headRef}"` };

  // Detect a fast-forward up front (base is an ancestor of head).
  const ffCheck = await runGit(repoPath, [
    "merge-base",
    "--is-ancestor",
    baseSha,
    headSha,
  ]);
  const fastForward = ffCheck.code === 0;

  const worktree = path.join(
    os.tmpdir(),
    `gm-merge-${crypto.randomBytes(6).toString("hex")}`,
  );

  try {
    const add = await runGit(repoPath, [
      "worktree",
      "add",
      "--detach",
      worktree,
      baseSha,
    ]);
    if (add.code !== 0) {
      return { status: "error", message: `worktree add failed: ${add.stderr.trim()}` };
    }

    const merge = await runGit(worktree, [
      "-c", "user.name=GitManager",
      "-c", "user.email=gitmanager@local",
      "merge",
      "--no-edit",
      headSha,
    ]);

    if (merge.code !== 0) {
      // Collect conflicted files before aborting.
      const conflicted = await runGit(worktree, [
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);
      const conflictedFiles = conflicted.stdout.split("\n").filter(Boolean);
      await runGit(worktree, ["merge", "--abort"]);
      return { status: "conflicted", conflictedFiles };
    }

    const resultSha = (await git(worktree, ["rev-parse", "HEAD"])).trim();

    // Compare-and-swap the base branch to the merge result.
    const update = await runGit(repoPath, [
      "update-ref",
      `refs/heads/${baseRef}`,
      resultSha,
      baseSha,
    ]);
    if (update.code !== 0) {
      return {
        status: "error",
        message: `failed to advance base branch (it moved concurrently): ${update.stderr.trim()}`,
      };
    }

    if (opts.deleteHeadOnMerge && headRef !== baseRef) {
      if (await branchExists(repoPath, headRef)) {
        // Best effort; never fail the merge over branch cleanup.
        await runGit(repoPath, ["branch", "-D", headRef]);
      }
    }

    return { status: "merged", mergeCommitSha: resultSha, fastForward };
  } finally {
    await cleanupWorktree(repoPath, worktree);
  }
}

async function cleanupWorktree(repoPath: string, worktree: string): Promise<void> {
  await runGit(repoPath, ["worktree", "remove", "--force", worktree]);
  // Prune any dangling administrative entries and remove leftovers.
  await runGit(repoPath, ["worktree", "prune"]);
  try {
    if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** Non-mutating merge check: never advances the base branch. */
export async function dryRunMerge(
  repoPath: string,
  baseRef: string,
  headRef: string,
): Promise<"clean" | "conflict" | "error"> {
  const baseSha = await revParse(repoPath, baseRef);
  const headSha = await revParse(repoPath, headRef);
  if (!baseSha || !headSha) return "error";

  const worktree = path.join(
    os.tmpdir(),
    `gm-dry-${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    const add = await runGit(repoPath, [
      "worktree",
      "add",
      "--detach",
      worktree,
      baseSha,
    ]);
    if (add.code !== 0) return "error";
    const merge = await runGit(worktree, ["merge", "--no-commit", "--no-ff", headSha]);
    await runGit(worktree, ["merge", "--abort"]);
    return merge.code === 0 ? "clean" : "conflict";
  } finally {
    await cleanupWorktree(repoPath, worktree);
  }
}
