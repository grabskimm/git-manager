import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import type { Pr, Repo } from "./types.js";
import { diffRange, diffStat } from "./git.js";
import { addThreadEntry } from "./store.js";
import type { WsHub } from "./ws.js";

/** Resolved at call time so tests and users can override the binary. */
function claudeBin(): string {
  return process.env.GITMANAGER_CLAUDE_BIN || "claude";
}
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

/** Is the `claude` CLI present and runnable? */
export function isClaudeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(claudeBin(), ["--version"], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
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

  if (!(await isClaudeAvailable())) {
    const reason =
      "The `claude` CLI was not found. Install Claude Code and run `claude` once to log in, then re-open the PR to get an automatic review.";
    persistSkip(db, pr, reason);
    hub.broadcast("review.skipped", { prId: pr.id, reason });
    return { status: "skipped", reason };
  }

  let diff: string;
  let stat: string;
  try {
    diff = await diffRange(repo.abs_path, pr.base_ref, pr.head_ref);
    stat = await diffStat(repo.abs_path, pr.base_ref, pr.head_ref);
  } catch (err) {
    const reason = `Could not compute the diff for review: ${(err as Error).message}`;
    persistSkip(db, pr, reason);
    hub.broadcast("review.skipped", { prId: pr.id, reason });
    return { status: "skipped", reason };
  }

  if (!diff.trim()) {
    const reason = "No changes between base and head — nothing to review.";
    persistSkip(db, pr, reason);
    hub.broadcast("review.skipped", { prId: pr.id, reason });
    return { status: "skipped", reason };
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

  return new Promise<ReviewResult>((resolve) => {
    let child;
    try {
      // Structured streaming output: works with a plain login and remains
      // compatible with environments that inject `--include-partial-messages`.
      child = spawn(
        claudeBin(),
        ["--print", "--verbose", "--output-format", "stream-json"],
        { cwd: repo.abs_path, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (err) {
      const reason = `Failed to launch \`claude\`: ${(err as Error).message}`;
      persistSkip(db, pr, reason);
      hub.broadcast("review.skipped", { prId: pr.id, reason });
      resolve({ status: "skipped", reason });
      return;
    }

    let buffer = "";
    let streamed = "";
    let resultText = "";
    let sawDelta = false;
    let stderr = "";

    const emit = (token: string): void => {
      if (!token) return;
      streamed += token;
      hub.broadcast("review.token", { prId: pr.id, token });
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return; // non-JSON noise
      }
      const delta = extractDeltaText(obj);
      if (delta !== null) {
        sawDelta = true;
        emit(delta);
        return;
      }
      // Full assistant message (only stream it if we never saw deltas).
      if (obj.type === "assistant" && !sawDelta) {
        const text = extractAssistantText(obj);
        if (text) emit(text);
      }
      if (obj.type === "result" && typeof obj.result === "string") {
        resultText = obj.result;
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("error", (err) => {
      const reason = `\`claude\` failed to run: ${err.message}`;
      persistSkip(db, pr, reason);
      hub.broadcast("review.skipped", { prId: pr.id, reason });
      resolve({ status: "skipped", reason });
    });

    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      const body = (resultText || streamed).trim();
      if (code !== 0 || !body) {
        const reason =
          stderr.trim() ||
          `\`claude\` exited with code ${code}. You may need to log in (run \`claude\` once).`;
        persistSkip(db, pr, reason);
        hub.broadcast("review.skipped", { prId: pr.id, reason });
        resolve({ status: "skipped", reason });
        return;
      }
      addThreadEntry(db, { pr_id: pr.id, author: "claude", kind: "review", body });
      hub.broadcast("review.done", { prId: pr.id });
      resolve({ status: "reviewed", body });
    });

    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

/** Pull incremental text from a stream-json partial-message event, if present. */
function extractDeltaText(obj: Record<string, unknown>): string | null {
  const event = obj.event as Record<string, unknown> | undefined;
  const candidate = event ?? obj;
  if (
    candidate &&
    candidate.type === "content_block_delta" &&
    candidate.delta &&
    typeof candidate.delta === "object"
  ) {
    const delta = candidate.delta as Record<string, unknown>;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return delta.text;
    }
  }
  return null;
}

/** Concatenate text blocks from a complete assistant message. */
function extractAssistantText(obj: Record<string, unknown>): string {
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is { type: string; text: string } =>
        !!p && typeof p === "object" && (p as { type?: string }).type === "text",
    )
    .map((p) => p.text)
    .join("");
}

function persistSkip(db: DB, pr: Pr, reason: string): void {
  addThreadEntry(db, {
    pr_id: pr.id,
    author: "system",
    kind: "review",
    body: `**Review skipped.** ${reason}`,
  });
}
