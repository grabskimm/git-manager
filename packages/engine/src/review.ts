import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import type { Pr, Repo } from "./types.js";
import { diffRange, diffStat } from "./git.js";
import { addThreadEntry } from "./store.js";
import type { WsHub } from "./ws.js";
import { isClaudeAvailable, runClaudeStreaming } from "./claudeProcess.js";

export { isClaudeAvailable };

const PROMPT_FILE = ".gitmanager-review-prompt.md";

const DEFAULT_PROMPT = `# GitManager — Code Review Prompt

You are reviewing a local pull request before it lands on the base branch.
There is no other reviewer; this is the quality gate.

Review the unified diff below. Be concise and concrete:

1. **Summary** — one or two sentences on what the change does.
2. **Correctness** — bugs, edge cases, broken invariants.
3. **Risk** — anything that could break callers or data.
4. **Suggestions** — focused, actionable improvements (skip nitpicks).

Reference files and lines where useful. If the change looks good, say so plainly.
`;

export function reviewPromptPath(repoPath: string): string {
  return path.join(repoPath, PROMPT_FILE);
}

/** Load the per-repo review prompt template, creating a default if absent. */
export function loadReviewPrompt(repoPath: string): string {
  const file = reviewPromptPath(repoPath);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    try {
      fs.writeFileSync(file, DEFAULT_PROMPT, "utf8");
    } catch {
      // read-only repo dir: fall back to in-memory default
    }
    return DEFAULT_PROMPT;
  }
}

export type ReviewResult =
  | { status: "reviewed"; body: string }
  | { status: "skipped"; reason: string };

/**
 * Run the Claude review for a PR as a local subprocess using the user's existing
 * `claude` login. Streams tokens over the WebSocket hub and persists the final
 * review into the PR thread. Never hard-fails the PR — degrades to "skipped".
 */
export async function runReview(
  db: DB,
  hub: WsHub,
  repo: Repo,
  pr: Pr,
): Promise<ReviewResult> {
  hub.broadcast("review.start", { prId: pr.id });

  const skip = (reason: string): ReviewResult => {
    persistSkip(db, pr, reason);
    hub.broadcast("review.skipped", { prId: pr.id, reason });
    return { status: "skipped", reason };
  };

  if (!(await isClaudeAvailable())) {
    return skip(
      "The `claude` CLI was not found. Install Claude Code and run `claude` once to log in, then re-open the PR to get an automatic review.",
    );
  }

  let diff: string;
  let stat: string;
  try {
    diff = await diffRange(repo.abs_path, pr.base_ref, pr.head_ref);
    stat = await diffStat(repo.abs_path, pr.base_ref, pr.head_ref);
  } catch (err) {
    return skip(`Could not compute the diff for review: ${(err as Error).message}`);
  }

  if (!diff.trim()) {
    return skip("No changes between base and head — nothing to review.");
  }

  const template = loadReviewPrompt(repo.abs_path);
  const fullPrompt = [
    template,
    "",
    "## Pull request",
    `Title: ${pr.title}`,
    pr.description ? `Description: ${pr.description}` : "",
    `Base: ${pr.base_ref}  →  Head: ${pr.head_ref}`,
    "",
    "## Diffstat",
    "```",
    stat.trim(),
    "```",
    "",
    "## Unified diff (base...head)",
    "```diff",
    diff,
    "```",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const result = await runClaudeStreaming({
    cwd: repo.abs_path,
    prompt: fullPrompt,
    onToken: (token) => hub.broadcast("review.token", { prId: pr.id, token }),
  });

  if (result.status === "skipped") return skip(result.reason);

  addThreadEntry(db, { pr_id: pr.id, author: "claude", kind: "review", body: result.body });
  hub.broadcast("review.done", { prId: pr.id });
  return { status: "reviewed", body: result.body };
}

function persistSkip(db: DB, pr: Pr, reason: string): void {
  addThreadEntry(db, {
    pr_id: pr.id,
    author: "system",
    kind: "review",
    body: `**Review skipped.** ${reason}`,
  });
}
