import type { DB } from "./db.js";
import type { WsHub } from "./ws.js";
import { listRepos } from "./store.js";
import { listBranches, log } from "./git.js";
import { isClaudeAvailable, runClaudeStreaming } from "./claudeProcess.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Build a read-only, metadata-only context block describing every repository in
 * the source list (name, path, branches, recent commits). No file contents —
 * the assistant reasons across all repos from this summary.
 */
async function buildRepoContext(db: DB): Promise<string> {
  const repos = listRepos(db);
  if (repos.length === 0) return "There are no repositories ingested yet.";

  const blocks: string[] = [];
  for (const repo of repos) {
    let branchLine = "";
    let commitsBlock = "";
    try {
      const branches = await listBranches(repo.abs_path);
      branchLine = branches.map((b) => b.name).join(", ");
      const commits = await log(repo.abs_path, repo.default_branch || "HEAD", 5);
      commitsBlock = commits.map((c) => `  - ${c.shortSha} ${c.subject}`).join("\n");
    } catch {
      // a single unreadable repo never breaks the context
    }
    blocks.push(
      [
        `### ${repo.display_name}`,
        `- id: ${repo.id}`,
        `- path: ${repo.abs_path}`,
        `- default branch: ${repo.default_branch ?? "(unknown)"}`,
        branchLine ? `- branches: ${branchLine}` : "",
        commitsBlock ? `- recent commits:\n${commitsBlock}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return blocks.join("\n\n");
}

const SYSTEM_PREAMBLE = `You are GitManager's assistant. The user manages several local git
repositories. Below is read-only metadata about every repository in their source list. Use it
to answer questions across all of their repos — comparisons, "which repo has…", what changed
recently, where something likely lives, and so on. If answering precisely would require file
contents you don't have, say what you'd need rather than guessing.`;

function composePrompt(context: string, history: ChatMessage[], message: string): string {
  const convo = history
    .slice(-12)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
  return [
    SYSTEM_PREAMBLE,
    "",
    "## Repositories (metadata only)",
    context,
    "",
    convo ? "## Conversation so far" : "",
    convo,
    "",
    "## Current question",
    message,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Answer a chat message about the user's repositories, streaming tokens over the
 * WebSocket. Uses the user's existing `claude` login; degrades gracefully when
 * `claude` is unavailable. `id` correlates the stream on the client.
 */
export async function runChat(
  db: DB,
  hub: WsHub,
  id: string,
  message: string,
  history: ChatMessage[],
  model?: string,
): Promise<void> {
  hub.broadcast("chat.start", { id });

  if (!(await isClaudeAvailable())) {
    hub.broadcast("chat.skipped", {
      id,
      reason:
        "The `claude` CLI was not found. Install Claude Code and run `claude` once to log in to use repo chat.",
    });
    return;
  }

  const context = await buildRepoContext(db);
  const prompt = composePrompt(context, history, message);

  const result = await runClaudeStreaming({
    prompt,
    model,
    onToken: (token) => hub.broadcast("chat.token", { id, token }),
  });

  if (result.status === "skipped") {
    hub.broadcast("chat.skipped", { id, reason: result.reason });
    return;
  }
  hub.broadcast("chat.done", { id, body: result.body });
}
