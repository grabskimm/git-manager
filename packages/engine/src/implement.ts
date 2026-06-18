import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { DB } from "./db.js";
import type { Pr, PrThreadEntry, Repo } from "./types.js";
import { runGit, git, revParse } from "./git.js";
import { addThreadEntry, listThread } from "./store.js";
import type { WsHub } from "./ws.js";
import { isClaudeAvailable, runClaudeAgent } from "./claudeProcess.js";

export type ImplementResult =
  | { status: "implemented"; commitSha: string; body: string }
  | { status: "no_changes"; body: string }
  | { status: "skipped"; reason: string };

/** Render the conversation so far for the implementation prompt. */
function renderConversation(thread: PrThreadEntry[]): string {
  const lines: string[] = [];
  for (const t of thread) {
    if (t.kind === "status_change") continue;
    const who = t.author === "claude" ? "Claude" : t.author === "user" ? "Author" : "System";
    const anchor = t.file_path ? ` [on ${t.file_path}${t.line ? ":" + t.line : ""}]` : "";
    lines.push(`### ${who}${anchor}\n${t.body}`);
  }
  return lines.join("\n\n");
}

async function cleanupWorktree(repoPath: string, worktree: string): Promise<void> {
  await runGit(repoPath, ["worktree", "remove", "--force", worktree]);
  await runGit(repoPath, ["worktree", "prune"]);
  try {
    if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Implement Claude's review suggestions on the PR's head branch.
 *
 * Runs `claude` with edit permissions inside a throwaway **detached** worktree
 * checked out at the head commit, so the user's working tree is never touched.
 * Any resulting changes are committed and the head branch is advanced with a
 * compare-and-swap `update-ref` (consistent with the merge engine). Streams
 * Claude's narration over the `review.*` events and records the outcome in the
 * PR thread. Never hard-fails — degrades to a skip note.
 */
export async function runImplement(
  db: DB,
  hub: WsHub,
  repo: Repo,
  pr: Pr,
): Promise<ImplementResult> {
  hub.broadcast("review.start", { prId: pr.id });

  const skip = (reason: string): ImplementResult => {
    addThreadEntry(db, {
      pr_id: pr.id,
      author: "system",
      kind: "comment",
      body: `**Implementation skipped.** ${reason}`,
    });
    hub.broadcast("review.skipped", { prId: pr.id, reason });
    return { status: "skipped", reason };
  };

  if (!(await isClaudeAvailable())) {
    return skip(
      "The `claude` CLI was not found. Install Claude Code and run `claude` once to log in.",
    );
  }

  const headSha = await revParse(repo.abs_path, pr.head_ref);
  if (!headSha) return skip(`Cannot resolve head branch \`${pr.head_ref}\`.`);

  const conversation = renderConversation(listThread(db, pr.id));
  const prompt = [
    "You are working inside a checkout of this repository on the PR's head branch.",
    "Implement the change(s) the author has asked for, based on your earlier review and the",
    "conversation below. Edit the actual files. Keep changes focused and consistent with the",
    "surrounding code. Do NOT commit — the changes will be committed for you. When done, give a",
    "short summary of what you changed and why.",
    "",
    `## Pull request`,
    `Title: ${pr.title}`,
    pr.description ? `Description: ${pr.description}` : "",
    `Base: ${pr.base_ref}  →  Head: ${pr.head_ref}`,
    "",
    "## Conversation so far",
    conversation,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const worktree = path.join(os.tmpdir(), `gm-impl-${crypto.randomBytes(6).toString("hex")}`);

  try {
    const add = await runGit(repo.abs_path, ["worktree", "add", "--detach", worktree, headSha]);
    if (add.code !== 0) {
      return skip(`Could not create a worktree: ${add.stderr.trim()}`);
    }

    const result = await runClaudeAgent({
      cwd: worktree,
      prompt,
      onToken: (token) => hub.broadcast("review.token", { prId: pr.id, token }),
    });

    if (result.status === "skipped") return skip(result.reason);

    // Stage everything and see whether Claude actually changed anything.
    await runGit(worktree, ["add", "-A"]);
    const status = await runGit(worktree, ["status", "--porcelain"]);
    if (!status.stdout.trim()) {
      addThreadEntry(db, { pr_id: pr.id, author: "claude", kind: "comment", body: result.body });
      hub.broadcast("review.done", { prId: pr.id });
      return { status: "no_changes", body: result.body };
    }

    const commit = await runGit(worktree, [
      "-c",
      "user.name=GitManager (Claude)",
      "-c",
      "user.email=claude@gitmanager.local",
      "commit",
      "-m",
      "Apply Claude's review suggestions",
    ]);
    if (commit.code !== 0) {
      return skip(`Could not commit the changes: ${commit.stderr.trim()}`);
    }

    const newSha = (await git(worktree, ["rev-parse", "HEAD"])).trim();

    // Compare-and-swap the head branch to the new commit (head moved? abort).
    const update = await runGit(repo.abs_path, [
      "update-ref",
      `refs/heads/${pr.head_ref}`,
      newSha,
      headSha,
    ]);
    if (update.code !== 0) {
      return skip(
        `Head branch \`${pr.head_ref}\` moved while implementing — no changes applied. ${update.stderr.trim()}`,
      );
    }

    addThreadEntry(db, { pr_id: pr.id, author: "claude", kind: "comment", body: result.body });
    addThreadEntry(db, {
      pr_id: pr.id,
      author: "system",
      kind: "status_change",
      body: `Claude implemented the change on \`${pr.head_ref}\` as \`${newSha.slice(0, 10)}\`.`,
    });
    hub.broadcast("review.done", { prId: pr.id });
    return { status: "implemented", commitSha: newSha, body: result.body };
  } finally {
    await cleanupWorktree(repo.abs_path, worktree);
  }
}
