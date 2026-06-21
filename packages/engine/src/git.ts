import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly result: GitResult,
    public readonly args: string[],
  ) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Invoke system `git` as a subprocess. We never reimplement git semantics;
 * this is a thin, typed wrapper for correctness on worktree/merge.
 */
export function runGit(
  cwd: string,
  args: string[],
  opts: { input?: string } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** Like runGit but throws on a nonzero exit. */
export async function git(
  cwd: string,
  args: string[],
  opts: { input?: string } = {},
): Promise<string> {
  const res = await runGit(cwd, args, opts);
  if (res.code !== 0) {
    throw new GitError(
      `git ${args.join(" ")} failed (${res.code}): ${res.stderr.trim()}`,
      res,
      args,
    );
  }
  return res.stdout;
}

let cachedUserName: string | null | undefined;

/**
 * The user's display name: global `git config user.name`, falling back to the
 * OS account name. Cached for the process lifetime. Null only if both are empty.
 */
export async function gitUserName(): Promise<string | null> {
  if (cachedUserName !== undefined) return cachedUserName;
  try {
    const res = await runGit(os.homedir(), ["config", "user.name"]);
    const name = res.stdout.trim();
    if (res.code === 0 && name) return (cachedUserName = name);
  } catch {
    // fall through to the OS account name
  }
  try {
    const u = os.userInfo().username?.trim();
    if (u) return (cachedUserName = u);
  } catch {
    // ignore
  }
  return (cachedUserName = null);
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const res = await runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
  return res.code === 0 && res.stdout.trim() === "true";
}

/** A git URL (https/http/git/ssh/file) or scp-like `user@host:path`. */
export function isRemoteUrl(s: string): boolean {
  return /^(https?|git|ssh|file):\/\//i.test(s) || /^[^/\\\s]+@[^/\\\s:]+:.+/.test(s);
}

/** Derive a repo directory name from a clone URL. */
export function repoNameFromUrl(url: string): string {
  const last =
    url
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .split(/[/:]/)
      .filter(Boolean)
      .pop() ?? "repo";
  return last.replace(/[^\w.-]/g, "-") || "repo";
}

/** Clone a remote repo into a local directory (the local .git stays canonical). */
export async function cloneRepo(url: string, targetDir: string): Promise<GitResult> {
  return runGit(process.cwd(), ["clone", url, targetDir]);
}

/**
 * Create a brand-new local repo in `dir` (which must already exist and be
 * empty): init on `main`, seed a README, and make an initial commit so the
 * repo has real history and a proper default branch. Best-effort identity flags
 * keep `git commit` from failing when the user has no global git identity.
 */
export async function createLocalRepo(dir: string, name: string): Promise<void> {
  let init = await runGit(dir, ["init", "-b", "main"]);
  if (init.code !== 0) {
    // Older git without `-b`: init, then point HEAD at main.
    init = await runGit(dir, ["init"]);
    if (init.code !== 0) {
      throw new GitError(`git init failed: ${init.stderr.trim()}`, init, ["init"]);
    }
    await runGit(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  }
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  await runGit(dir, ["add", "-A"]);
  // Identity flags are a fallback; a configured global identity still wins.
  await runGit(dir, [
    "-c",
    "user.name=GitManager",
    "-c",
    "user.email=gitmanager@localhost",
    "commit",
    "-m",
    "Initial commit",
  ]);
}

/** Top-level work tree of a repo containing `dir`, or null. */
export async function repoToplevel(dir: string): Promise<string | null> {
  const res = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (res.code !== 0) return null;
  return res.stdout.trim() || null;
}

export async function hasCommits(repo: string): Promise<boolean> {
  const res = await runGit(repo, ["rev-parse", "--verify", "HEAD"]);
  return res.code === 0;
}

/**
 * The earliest root commit SHA (by commit date) — the stable identity anchor
 * for a repo with no remote. Handles multiple roots deterministically.
 */
export async function earliestRootCommit(repo: string): Promise<string | null> {
  const res = await runGit(repo, [
    "rev-list",
    "--max-parents=0",
    "--date-order",
    "HEAD",
  ]);
  if (res.code !== 0) return null;
  const roots = res.stdout.trim().split("\n").filter(Boolean);
  if (roots.length === 0) return null;
  // --date-order lists newest first; the earliest by date is the last line.
  return roots[roots.length - 1] ?? null;
}

export interface BranchInfo {
  name: string;
  sha: string;
  isHead: boolean;
}

export async function listBranches(repo: string): Promise<BranchInfo[]> {
  const out = await git(repo, [
    "for-each-ref",
    "--format=%(refname:short)%09%(objectname)%09%(HEAD)",
    "refs/heads",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha, head] = line.split("\t");
      return { name: name ?? "", sha: sha ?? "", isHead: head === "*" };
    });
}

export async function currentBranch(repo: string): Promise<string | null> {
  const res = await runGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (res.code !== 0) return null; // detached HEAD
  return res.stdout.trim() || null;
}

export async function defaultBranch(repo: string): Promise<string | null> {
  // No remotes by design: prefer the checked-out branch, else common names.
  const head = await currentBranch(repo);
  if (head) return head;
  const branches = await listBranches(repo);
  for (const candidate of ["main", "master", "trunk"]) {
    if (branches.some((b) => b.name === candidate)) return candidate;
  }
  return branches[0]?.name ?? null;
}

export async function branchExists(repo: string, name: string): Promise<boolean> {
  const res = await runGit(repo, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${name}`,
  ]);
  return res.code === 0;
}

export async function revParse(repo: string, ref: string): Promise<string | null> {
  const res = await runGit(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (res.code !== 0) return null;
  return res.stdout.trim() || null;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export async function log(
  repo: string,
  ref: string,
  limit = 100,
): Promise<CommitInfo[]> {
  const sep = "\x1f";
  const rec = "\x1e";
  const fmt = ["%H", "%h", "%an", "%ae", "%aI", "%s"].join(sep) + rec;
  const res = await runGit(repo, [
    "log",
    `--max-count=${limit}`,
    `--format=${fmt}`,
    ref,
  ]);
  if (res.code !== 0) return [];
  return res.stdout
    .split(rec)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, author, email, date, subject] = line.split(sep);
      return {
        sha: sha ?? "",
        shortSha: shortSha ?? "",
        author: author ?? "",
        email: email ?? "",
        date: date ?? "",
        subject: subject ?? "",
      };
    });
}

/** Unified diff for base...head (merge-base diff, matching PR semantics). */
export async function diffRange(
  repo: string,
  base: string,
  head: string,
): Promise<string> {
  const res = await runGit(repo, ["diff", `${base}...${head}`]);
  if (res.code !== 0) {
    // Fall back to two-dot when there is no common ancestor.
    const two = await runGit(repo, ["diff", `${base}..${head}`]);
    return two.stdout;
  }
  return res.stdout;
}

export async function diffStat(
  repo: string,
  base: string,
  head: string,
): Promise<string> {
  const res = await runGit(repo, ["diff", "--stat", `${base}...${head}`]);
  return res.code === 0 ? res.stdout : "";
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "tree" | "blob";
  size: number | null;
}

/** List immediate children of a directory at a given ref. */
export async function listTree(
  repo: string,
  ref: string,
  dirPath = "",
): Promise<TreeEntry[]> {
  const prefix = dirPath ? dirPath.replace(/\/?$/, "/") : "";
  const args = ["ls-tree", "-l", ref];
  if (prefix) args.push(prefix);
  const res = await runGit(repo, args);
  if (res.code !== 0) return [];
  const entries: TreeEntry[] = [];
  for (const line of res.stdout.split("\n")) {
    const m = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(\S+)\t(.*)$/.exec(line);
    if (!m) continue;
    const type = m[2] === "tree" ? "tree" : "blob";
    const sizeRaw = m[4];
    const fullPath = m[5] ?? "";
    const name = fullPath.split("/").filter(Boolean).pop() ?? fullPath;
    entries.push({
      name,
      path: fullPath,
      type,
      size: sizeRaw === "-" ? null : Number(sizeRaw),
    });
  }
  // Directories first, then files; each alphabetically.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export interface FileContent {
  path: string;
  ref: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string;
}

const MAX_FILE_BYTES = 1_000_000;

/** Read a file's contents at a ref, guarding against binary/huge blobs. */
export async function readFile(
  repo: string,
  ref: string,
  filePath: string,
): Promise<FileContent | null> {
  const sizeRes = await runGit(repo, ["cat-file", "-s", `${ref}:${filePath}`]);
  if (sizeRes.code !== 0) return null;
  const size = Number(sizeRes.stdout.trim()) || 0;

  if (size > MAX_FILE_BYTES) {
    return { path: filePath, ref, size, binary: false, truncated: true, content: "" };
  }

  const res = await runGit(repo, ["show", `${ref}:${filePath}`]);
  if (res.code !== 0) return null;
  const binary = res.stdout.indexOf("\u0000") !== -1;
  return {
    path: filePath,
    ref,
    size,
    binary,
    truncated: false,
    content: binary ? "" : res.stdout,
  };
}
