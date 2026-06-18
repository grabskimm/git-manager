import { execSync, spawn } from "node:child_process";
import { startEngine } from "./server.js";
import { loadOrCreateToken } from "./token.js";

interface Pr {
  id: string;
  repo_id: string;
  title: string;
  base_ref: string;
  head_ref: string;
  status: string;
  merge_commit_sha: string | null;
}
interface Repo {
  id: string;
  display_name: string;
  default_branch: string | null;
  abs_path: string;
}

function port(): number {
  return process.env.GITMANAGER_PORT ? Number(process.env.GITMANAGER_PORT) : 4317;
}
function origin(): string {
  return `http://127.0.0.1:${port()}`;
}

/** Call the running engine's API with the loopback token + Origin (§7). */
async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = loadOrCreateToken();
  let res: Response;
  try {
    res = await fetch(`${origin()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: origin(),
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(
      `Could not reach the GitManager engine at ${origin()}. Start it first with \`gitm\` (or \`gitm start\`).`,
    );
  }
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === "object" && "error" in parsed && String(parsed.error)) ||
      `HTTP ${res.status}`;
    const extra =
      parsed && typeof parsed === "object" && "message" in parsed ? `: ${parsed.message}` : "";
    throw new Error(`${msg}${extra}`);
  }
  return parsed as T;
}

/** Parse `--key value` / `--flag` pairs and positional args. */
function parseFlags(args: string[]): { _: string[]; flags: Record<string, string | true> } {
  const _: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function gitCmd(args: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

interface CwdContext {
  repo: Repo;
  branch: string;
}

/** Detect the repo and branch from the current working directory. */
async function detectCwdContext(): Promise<CwdContext | null> {
  const repoRoot = gitCmd("rev-parse --show-toplevel");
  if (!repoRoot) return null;
  const branch = gitCmd("branch --show-current");
  if (!branch) return null;
  const repos = await apiCall<Repo[]>("GET", "/api/repos");
  const repo = repos.find((r) => r.abs_path === repoRoot);
  if (!repo) return null;
  return { repo, branch };
}

/** Resolve a repo by exact id, exact display name, or unique prefix/substring. */
async function resolveRepo(ref: string): Promise<Repo> {
  const repos = await apiCall<Repo[]>("GET", "/api/repos");
  const exact = repos.find((r) => r.id === ref || r.display_name === ref);
  if (exact) return exact;
  const matches = repos.filter(
    (r) => r.id.startsWith(ref) || r.display_name.toLowerCase().includes(ref.toLowerCase()),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`No repo matches "${ref}". Try \`gitm repos\`.`);
  throw new Error(
    `"${ref}" is ambiguous (${matches.map((m) => m.display_name).join(", ")}). Be more specific.`,
  );
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ---- commands ----

async function cmdRepos(): Promise<void> {
  const repos = await apiCall<Repo[]>("GET", "/api/repos");
  if (repos.length === 0) {
    process.stdout.write("No repositories. Add a source directory in the UI or API first.\n");
    return;
  }
  for (const r of repos) {
    process.stdout.write(
      `${pad(r.display_name, 28)} ${pad(r.default_branch ?? "-", 12)} ${r.id.slice(0, 16)}\n`,
    );
  }
}

async function cmdPrList(flags: Record<string, string | true>): Promise<void> {
  const repoRef = str(flags.repo);
  let path = "/api/prs";
  if (repoRef) path += `?repoId=${encodeURIComponent((await resolveRepo(repoRef)).id)}`;
  const prs = await apiCall<Pr[]>("GET", path);
  if (prs.length === 0) {
    process.stdout.write("No pull requests.\n");
    return;
  }
  for (const p of prs) {
    process.stdout.write(
      `${pad(p.status, 11)} ${pad(p.head_ref + " -> " + p.base_ref, 28)} ${pad(p.title, 36)} ${p.id}\n`,
    );
  }
}

async function cmdPrCreate(flags: Record<string, string | true>): Promise<void> {
  const repoRef = str(flags.repo);
  let base = str(flags.base);
  let head = str(flags.head);
  let title = str(flags.title);

  let repo: Repo | undefined;

  // Auto-detect from cwd when any of the key fields are missing.
  if (!repoRef || !head || !base) {
    const ctx = await detectCwdContext().catch(() => null);
    if (ctx) {
      if (!repo && !repoRef) repo = ctx.repo;
      if (!head) head = ctx.branch;
      if (!base) base = ctx.repo.default_branch ?? "main";
      // Default title to the last commit subject on this branch.
      if (!title) title = gitCmd("log -1 --pretty=%s") || head;
    }
  }

  if (!repo) {
    if (!repoRef)
      throw new Error(
        "Not inside a tracked repo. Specify --repo <id|name>, or run from inside a tracked repo.",
      );
    repo = await resolveRepo(repoRef);
  }
  if (!head)
    throw new Error("Not on a branch. Specify --head <ref>, or run from inside a tracked repo.");
  if (!base) base = repo.default_branch ?? "main";
  if (!title) title = head;

  if (head === base)
    throw new Error(`head and base are both "${head}". Nothing to merge.`);

  const pr = await apiCall<Pr>("POST", "/api/prs", {
    repo_id: repo.id,
    base_ref: base,
    head_ref: head,
    title,
    description: str(flags.description),
  });
  process.stdout.write(
    `Opened PR ${pr.id}\n  ${pr.head_ref} -> ${pr.base_ref}  (${repo.display_name})\n  Title: ${pr.title}\n  A Claude review is running; view it at ${origin()}/prs/${pr.id}\n`,
  );
}

async function cmdPrMerge(id: string | undefined): Promise<void> {
  if (!id) throw new Error("Usage: gitm pr merge <pr-id>");
  const pr = await apiCall<Pr>("POST", `/api/prs/${id}/merge`);
  if (pr.status === "merged") {
    process.stdout.write(`Merged ${pr.id} as ${pr.merge_commit_sha}\n`);
  } else {
    process.stdout.write(`PR is now "${pr.status}".\n`);
  }
}

async function cmdPrClose(id: string | undefined): Promise<void> {
  if (!id) throw new Error("Usage: gitm pr close <pr-id>");
  const pr = await apiCall<Pr>("POST", `/api/prs/${id}/close`);
  process.stdout.write(`Closed ${pr.id} (status: ${pr.status})\n`);
}

interface PrDetail {
  pr: Pr;
  thread: { author: string; kind: string; body: string; file_path: string | null; line: number | null }[];
  repo: Repo | undefined;
}

async function cmdPrView(id: string | undefined): Promise<void> {
  if (!id) throw new Error("Usage: gitm pr view <pr-id>");
  const d = await apiCall<PrDetail>("GET", `/api/prs/${id}`);
  process.stdout.write(
    `${d.pr.title}\n  ${d.pr.status} · ${d.pr.head_ref} -> ${d.pr.base_ref} · ${d.repo?.display_name ?? d.pr.repo_id}\n\n`,
  );
  for (const t of d.thread) {
    const anchor = t.file_path ? ` [${t.file_path}${t.line ? ":" + t.line : ""}]` : "";
    process.stdout.write(`--- ${t.author} (${t.kind})${anchor} ---\n${t.body}\n\n`);
  }
}

async function cmdPr(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  const { _, flags } = parseFlags(rest);
  switch (sub) {
    case "list":
      return cmdPrList(flags);
    case "create":
      return cmdPrCreate(flags);
    case "merge":
      return cmdPrMerge(_[0]);
    case "close":
      return cmdPrClose(_[0]);
    case "view":
      return cmdPrView(_[0]);
    default:
      throw new Error("Usage: gitm pr <list|create|merge|close|view> …");
  }
}

interface SourceDir {
  id: string;
  path: string;
  added_at: string;
}

async function cmdSourceList(): Promise<void> {
  const dirs = await apiCall<SourceDir[]>("GET", "/api/source-dirs");
  if (dirs.length === 0) {
    process.stdout.write("No source directories.\n");
    return;
  }
  for (const d of dirs) process.stdout.write(`${pad(d.id.slice(0, 8), 10)} ${d.path}\n`);
}

async function cmdSourceAdd(pathOrUrl: string | undefined): Promise<void> {
  if (!pathOrUrl) throw new Error("Usage: gitm source add <path|url>");
  const res = await apiCall<{ scanned: number; cloned?: string }>("POST", "/api/source-dirs", {
    path: pathOrUrl,
  });
  const cloned = res.cloned ? ` (cloned into ${res.cloned})` : "";
  process.stdout.write(
    `Added. ${res.scanned} repositor${res.scanned === 1 ? "y" : "ies"} now tracked${cloned}.\n`,
  );
}

async function cmdSourceRemove(id: string | undefined): Promise<void> {
  if (!id) throw new Error("Usage: gitm source remove <id>");
  await apiCall("DELETE", `/api/source-dirs/${id}`);
  process.stdout.write(`Removed source directory ${id}.\n`);
}

async function cmdSource(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "list":
      return cmdSourceList();
    case "add":
      return cmdSourceAdd(args[1]);
    case "remove":
    case "rm":
      return cmdSourceRemove(args[1]);
    default:
      throw new Error("Usage: gitm source <list|add|remove> …");
  }
}

async function cmdScan(): Promise<void> {
  const res = await apiCall<{ scanned: number; repos: Repo[] }>("POST", "/api/scan");
  process.stdout.write(
    `Scanned ${res.scanned} source director${res.scanned === 1 ? "y" : "ies"}; ${res.repos.length} repositor${res.repos.length === 1 ? "y" : "ies"} found.\n`,
  );
}

function openBrowser(url: string): void {
  if (process.env.GITMANAGER_NO_OPEN || process.argv.includes("--no-open")) return;
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // headless / no browser — fine, the URL is printed.
  }
}

/** Invoked by Claude Code hooks to nudge an agent refresh; fire-and-forget. */
async function hookEvent(): Promise<void> {
  try {
    await apiCall("POST", "/api/agents/hook", {});
  } catch {
    // engine not running — nothing to nudge
  }
}

function help(): void {
  process.stdout.write(
    [
      "gitm — local-first git UI with local PRs and AI review",
      "",
      "Usage:",
      "  gitm [start]                         Start the engine and open the UI (default)",
      "  gitm source add <path|url>           Add a source directory (or clone a URL)",
      "  gitm source list                     List source directories",
      "  gitm source remove <id>              Remove a source directory",
      "  gitm scan                            Re-scan all source directories",
      "  gitm repos                           List ingested repositories",
      "  gitm pr list [--repo <id|name>]      List pull requests",
      "  gitm pr create [--repo <id|name>] [--base <ref>] [--head <ref>] [--title <t>] [--description <d>]",
      "                                   (inside a tracked repo, all flags are optional)",
      "  gitm pr view <pr-id>                 Show a PR and its review thread",
      "  gitm pr merge <pr-id>                Merge a PR (ff / merge-commit)",
      "  gitm pr close <pr-id>                Close a PR",
      "  gitm hook-event                      Internal: nudge agent refresh (used by hooks)",
      "",
      "Options:",
      "  --no-open                            Do not open a browser (with start)",
      "",
      "Env:",
      "  GITMANAGER_PORT   Engine port (default 4317)",
      "  GITMANAGER_HOME   State dir (default ~/.gitmanager)",
      "",
      "Subcommands talk to a running engine over loopback using the local token.",
      "",
    ].join("\n"),
  );
}

async function startServer(): Promise<void> {
  let engine: Awaited<ReturnType<typeof startEngine>>;
  try {
    engine = await startEngine();
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).message ?? String(err);
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write(
        `Port ${port()} is already in use — the GitManager engine appears to be running.\n` +
          `Use subcommands to talk to it:  gitm repos · gitm pr list · gitm scan\n` +
          `Or stop the running engine and retry.\n`,
      );
      process.exit(1);
    }
    throw new Error(msg);
  }
  engine.ctx.agents.installHooks("gitm hook-event");
  process.stdout.write(
    [
      "",
      "  GitManager engine running (loopback only)",
      `  ➜  ${engine.url}`,
      "  Token stored at ~/.gitmanager/token (injected into the served UI)",
      "",
    ].join("\n") + "\n",
  );
  openBrowser(engine.url);
  const shutdown = async (): Promise<void> => {
    await engine.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
    case "start":
      return startServer();
    case "hook-event":
      await hookEvent();
      return;
    case "repos":
      return cmdRepos();
    case "source":
    case "sources":
      return cmdSource(rest);
    case "scan":
      return cmdScan();
    case "pr":
      return cmdPr(rest);
    case "--help":
    case "-h":
    case "help":
      return help();
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n`);
      help();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
