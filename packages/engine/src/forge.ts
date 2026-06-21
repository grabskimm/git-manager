import { spawn } from "node:child_process";
import { runGit } from "./git.js";

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run an arbitrary command (used for `gh`), capturing output. Never throws. */
function run(cmd: string, args: string[], cwd: string, input?: string): Promise<CmdResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr || String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

/** Is the GitHub CLI installed and on PATH? */
export async function isGhAvailable(): Promise<boolean> {
  const res = await run("gh", ["--version"], process.cwd());
  return res.code === 0;
}

/** The `origin` remote URL, or null if the repo has no such remote. */
export async function getRemoteUrl(repoPath: string, remote = "origin"): Promise<string | null> {
  const res = await runGit(repoPath, ["remote", "get-url", remote]);
  const url = res.stdout.trim();
  return res.code === 0 && url ? url : null;
}

/** Parse `owner/repo` from a GitHub https/ssh/scp-style URL, or null. */
export function parseGitHubSlug(url: string): string | null {
  const u = url.trim().replace(/\.git$/, "");
  // https://github.com/owner/repo  |  http://...
  let m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)/i.exec(u);
  if (m) return `${m[1]}/${m[2]}`;
  // git@github.com:owner/repo  |  ssh://git@github.com/owner/repo
  m = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+)/i.exec(u);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

export type RemotePrResult =
  | { status: "created"; url: string }
  | { status: "skipped"; reason: string };

/**
 * Push the head branch to `origin` and open a PR on GitHub via `gh`. Uses the
 * user's existing `gh` login (no tokens stored). Never throws — returns a skip
 * result with guidance so the local PR is never blocked.
 */
export async function createGitHubPr(
  repoPath: string,
  opts: { base: string; head: string; title: string; body: string },
): Promise<RemotePrResult> {
  const url = await getRemoteUrl(repoPath);
  if (!url) return { status: "skipped", reason: "No `origin` remote is configured for this repo." };
  const slug = parseGitHubSlug(url);
  if (!slug) {
    return { status: "skipped", reason: `\`origin\` (${url}) is not a recognized GitHub remote.` };
  }
  if (!(await isGhAvailable())) {
    return {
      status: "skipped",
      reason: "The GitHub CLI (`gh`) was not found. Install it and run `gh auth login`.",
    };
  }

  // Push the head branch (idempotent; sets upstream).
  const push = await runGit(repoPath, ["push", "-u", "origin", opts.head]);
  if (push.code !== 0) {
    return { status: "skipped", reason: `\`git push\` failed: ${push.stderr.trim()}` };
  }

  const create = await run(
    "gh",
    [
      "pr",
      "create",
      "--base",
      opts.base,
      "--head",
      opts.head,
      "--title",
      opts.title,
      "--body-file",
      "-",
    ],
    repoPath,
    opts.body || opts.title,
  );
  if (create.code !== 0) {
    // gh prints "a pull request for branch ... already exists: <url>" to stderr.
    const existing = /(https:\/\/github\.com\/\S+\/pull\/\d+)/.exec(create.stderr);
    if (existing) return { status: "created", url: existing[1] };
    return { status: "skipped", reason: `\`gh pr create\` failed: ${create.stderr.trim()}` };
  }
  const prUrl = (create.stdout.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [])[0];
  return prUrl
    ? { status: "created", url: prUrl }
    : { status: "skipped", reason: "Opened the PR but could not parse its URL from `gh` output." };
}

/** Post a comment on a GitHub PR via `gh`. Best-effort; returns ok flag. */
export async function commentGitHubPr(
  repoPath: string,
  prUrl: string,
  body: string,
): Promise<boolean> {
  const res = await run("gh", ["pr", "comment", prUrl, "--body-file", "-"], repoPath, body);
  return res.code === 0;
}
