import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startEngine } from "./server.js";
import { loadOrCreateToken } from "./token.js";
import { logPath, pidPath } from "./paths.js";
import { appVersion } from "./version.js";
import { setVerbose } from "./logger.js";

/** The npm package that ships the `gitm` CLI (engine + bundled UI). */
const NPM_PACKAGE = "@git-manager/engine";

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

/**
 * Normalize a path for comparison: resolve symlinks (so /var vs /private/var
 * and home symlinks agree) and strip a trailing separator. Falls back to a
 * plain resolve if the path can't be realpath'd.
 */
function canonicalPath(p: string): string {
  let out = p;
  try {
    out = fs.realpathSync(p);
  } catch {
    out = path.resolve(p);
  }
  return out.replace(/[/\\]+$/, "");
}

/** Compare two paths, tolerating case-insensitive filesystems (macOS/Windows). */
function samePath(a: string, b: string): boolean {
  const ca = canonicalPath(a);
  const cb = canonicalPath(b);
  return ca === cb || ca.toLowerCase() === cb.toLowerCase();
}

/** Detect the repo and branch from the current working directory. */
async function detectCwdContext(): Promise<CwdContext | null> {
  const repoRoot = gitCmd("rev-parse --show-toplevel");
  if (!repoRoot) return null;
  const branch = gitCmd("branch --show-current");
  if (!branch) return null;
  const repos = await apiCall<Repo[]>("GET", "/api/repos");
  const repo = repos.find((r) => samePath(r.abs_path, repoRoot));
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
    if (!repoRef) {
      const root = gitCmd("rev-parse --show-toplevel");
      const hint = root
        ? `This directory's git root is:\n  ${root}\nbut no tracked repo matches it. Run \`gitm repos\` to see tracked repos, or add its parent folder as a source directory.`
        : "This directory isn't inside a git repository.";
      throw new Error(`Not inside a tracked repo. ${hint}\nOr pass --repo <id|name> explicitly.`);
    }
    repo = await resolveRepo(repoRef);
  }
  if (!head)
    throw new Error("Not on a branch. Specify --head <ref>, or run from inside a tracked repo.");
  if (!base) base = repo.default_branch ?? "main";
  if (!title) title = head;

  if (head === base)
    throw new Error(`head and base are both "${head}". Nothing to merge.`);

  const remote = flags.remote === true;
  const pr = await apiCall<Pr>("POST", "/api/prs", {
    repo_id: repo.id,
    base_ref: base,
    head_ref: head,
    title,
    description: str(flags.description),
    remote,
  });
  const remoteNote = remote
    ? "\n  --remote: pushing & opening a PR on the forge via gh (see the thread for status)"
    : "";
  process.stdout.write(
    `Opened PR ${pr.id}\n  ${pr.head_ref} -> ${pr.base_ref}  (${repo.display_name})\n  Title: ${pr.title}${remoteNote}\n  A Claude review is running; view it at ${origin()}/prs/${pr.id}\n`,
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

// ---- sync (object-storage backup) ----

interface SyncStatus {
  sync_enabled: boolean;
  sync_interval_minutes: number;
  backends: { id: string; label: string; enabled: boolean; ready: { ok: boolean; reason?: string } }[];
  manifest: { updatedAt: string; repos: Record<string, { name: string; lastBackupAt: string; bytes: number }> } | null;
  manifestFrom: string | null;
}

async function cmdSyncStatus(): Promise<void> {
  const s = await apiCall<SyncStatus>("GET", "/api/sync/status");
  process.stdout.write(
    `Scheduled backup: ${s.sync_enabled ? `on (every ${s.sync_interval_minutes}m)` : "off (manual)"}\n`,
  );
  if (s.backends.length === 0) {
    process.stdout.write("No storage backends configured. Add one in Settings → Backup.\n");
  } else {
    process.stdout.write("Backends:\n");
    for (const b of s.backends) {
      const state = !b.enabled ? "disabled" : b.ready.ok ? "ready" : `not ready: ${b.ready.reason}`;
      process.stdout.write(`  ${pad(b.label, 36)} ${state}\n`);
    }
  }
  if (s.manifest) {
    const repos = Object.entries(s.manifest.repos);
    process.stdout.write(`\nBacked up repos (${repos.length}) — from ${s.manifestFrom}:\n`);
    for (const [gmId, r] of repos) {
      process.stdout.write(`  ${pad(r.name, 28)} ${pad(gmId.slice(0, 16), 18)} ${r.lastBackupAt}\n`);
    }
  }
}

async function cmdSyncPush(flags: Record<string, string | true>): Promise<void> {
  const repoRef = str(flags.repo);
  const repoId = repoRef ? (await resolveRepo(repoRef)).id : undefined;
  const res = await apiCall<{
    pushed: { repo: string; gmId: string; results: { backend: string; status: string; reason?: string; bytes?: number }[] }[];
  }>("POST", "/api/sync/push", { repoId });
  for (const p of res.pushed) {
    process.stdout.write(`${p.repo}:\n`);
    for (const r of p.results) {
      const detail = r.status === "ok" ? `${((r.bytes ?? 0) / 1024).toFixed(0)} KiB` : r.reason ?? "";
      process.stdout.write(`  ${pad(r.backend, 36)} ${r.status}  ${detail}\n`);
    }
  }
}

async function cmdSyncPull(gmId: string | undefined, flags: Record<string, string | true>): Promise<void> {
  if (!gmId) throw new Error("Usage: gitm sync pull <gm-id> [--into <dir>]  (see `gitm sync status` for ids)");
  const res = await apiCall<{ status: string; reason?: string; path?: string; refs?: string[] }>(
    "POST",
    "/api/sync/pull",
    { gmId, into: str(flags.into) },
  );
  if (res.status === "cloned") process.stdout.write(`Cloned to ${res.path}\n`);
  else if (res.status === "updated")
    process.stdout.write(`Fetched into ${res.path} as refs/remotes/gm-backup/* (${(res.refs ?? []).length} branches)\n`);
  else process.stdout.write(`Skipped: ${res.reason}\n`);
}

async function cmdSyncConfig(): Promise<void> {
  const cfg = await apiCall<unknown>("GET", "/api/sync/config");
  process.stdout.write(
    `Storage config (~/.gitmanager/storage.json):\n${JSON.stringify(cfg, null, 2)}\n` +
      `Edit it there or in Settings → Backup. Credentials come from your provider logins ` +
      `(aws sso login / wrangler login / az login) — no keys are stored here.\n`,
  );
}

async function cmdSync(args: string[]): Promise<void> {
  const sub = args[0];
  const { _, flags } = parseFlags(args.slice(1));
  switch (sub) {
    case "status":
      return cmdSyncStatus();
    case "push":
      return cmdSyncPush(flags);
    case "pull":
      return cmdSyncPull(_[0], flags);
    case "config":
      return cmdSyncConfig();
    default:
      throw new Error("Usage: gitm sync <status|push|pull|config> …");
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
  if (process.env.GITMANAGER_NO_OPEN) return;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Is an engine already answering on our loopback port? Hits the unauthenticated
 * `/healthz` probe so this stays side-effect-free — it must not call
 * `loadOrCreateToken()`, which would mint a token file just to check liveness
 * (and a token rotation would otherwise turn a 401 into a false "not running").
 */
async function isEngineRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${origin()}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the engine detached so the terminal stays free. Re-execs this same CLI
 * as `start --foreground` (with GITMANAGER_BACKGROUND=1 so the engine writes its
 * own pid file once it has actually bound the port) and waits until it answers
 * before reporting. Idempotent: if one is already running we don't spawn a
 * second (which would EADDRINUSE).
 *
 * The launcher deliberately does NOT write the pid file: only the process that
 * wins the port should own it, and it must record its own pid after binding, so
 * a losing concurrent start (or a slow startup) can never leave a dead/foreign
 * pid behind for `gitm stop` to signal.
 */
async function startBackground(opts: { open: boolean }): Promise<void> {
  if (await isEngineRunning()) {
    process.stdout.write(`GitManager engine already running — ${origin()}\n`);
    if (opts.open) {
      process.stdout.write(`Opening ${origin()}\n`);
      openBrowser(origin());
    }
    return;
  }

  const script = fileURLToPath(import.meta.url);
  // Under tsx/ts-node the entrypoint is a .ts file plain Node can't execute, so
  // a detached `node <script>` would fail. Run in the foreground instead — this
  // keeps `npm run dev` (which execs src/cli.ts) working.
  if (/\.tsx?$/.test(script)) {
    process.stdout.write(
      "Running from a TypeScript entrypoint (dev) — starting in the foreground.\n",
    );
    return startServer();
  }

  const out = fs.openSync(logPath(), "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [script, "start", "--foreground"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, GITMANAGER_BACKGROUND: "1" },
    });
  } catch (e) {
    // spawn can throw synchronously (e.g. EACCES); don't fall through to
    // child.unref() on an undefined child and mask the real error.
    fs.closeSync(out);
    process.stderr.write(`Failed to start the engine: ${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  fs.closeSync(out);
  child.unref();

  // Wait (up to ~10s) for the engine to accept requests before reporting.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isEngineRunning()) {
      process.stdout.write(
        [
          "",
          "  GitManager engine running in the background (loopback only)",
          `  ➜  ${origin()}`,
          `  logs:  ${logPath()}`,
          "  stop:  gitm stop",
          "",
        ].join("\n") + "\n",
      );
      if (opts.open) {
        process.stdout.write(`  opening ${origin()}\n`);
        openBrowser(origin());
      }
      return;
    }
    await delay(250);
  }
  // Didn't come up in time. Don't touch the pid file — the engine owns it and
  // may simply be slow to bind; deleting it could orphan a real background
  // engine from `gitm stop`.
  process.stderr.write(
    `The engine isn't responding yet. It may still be starting — check the log:\n  ${logPath()}\n`,
  );
  process.exitCode = 1;
}

/** Open the UI, starting the engine in the background first if it isn't up. */
async function cmdOpen(): Promise<void> {
  if (await isEngineRunning()) {
    process.stdout.write(`Opening ${origin()}\n`);
    openBrowser(origin());
    return;
  }
  await startBackground({ open: true });
}

/** Stop the background engine via its pid file. */
async function cmdStop(): Promise<void> {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidPath(), "utf8").trim()) || 0;
  } catch {
    // no pid file
  }

  // Confirm an engine is actually answering before we signal anything. If the
  // port is silent, the pid file is stale — clearing it is correct, and we must
  // NOT kill that PID (it may have been reused by an unrelated process).
  if (!(await isEngineRunning())) {
    if (pid) {
      try {
        fs.rmSync(pidPath());
      } catch {
        // already gone
      }
    }
    process.stdout.write("No background engine is running.\n");
    return;
  }

  if (!pid) {
    process.stdout.write(
      `An engine is running at ${origin()} but there's no pid file ` +
        `(likely started with \`gitm start --foreground\`). Stop it where it runs.\n`,
    );
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    process.stdout.write(`Stopped GitManager engine (pid ${pid}).\n`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") {
      process.stdout.write(`Engine (pid ${pid}) wasn't running; cleared stale pid file.\n`);
    } else {
      throw e;
    }
  } finally {
    try {
      fs.rmSync(pidPath());
    } catch {
      // already gone
    }
  }
}

/** Is this CLI running from a global npm install (vs. a source/dev checkout)? */
function isInstalledPackage(): boolean {
  return fileURLToPath(import.meta.url).includes(`${path.sep}node_modules${path.sep}`);
}

/** Run `npm` to completion, echoing its output. Resolves the exit code + stderr. */
function runNpm(args: string[]): Promise<{ code: number; stderr: string }> {
  const bin = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "inherit", "pipe"] });
    } catch (e) {
      resolve({ code: -1, stderr: String(e) });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s); // surface progress/errors live
    });
    child.on("error", (e) => resolve({ code: -1, stderr: stderr || String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/**
 * One-shot upgrade: `npm install -g <pkg>@latest`, then bounce the background
 * engine so the new build is actually serving. Only meaningful for a global npm
 * install — a source/dev checkout is told to use the build-from-source flow.
 */
async function cmdUpdate(): Promise<void> {
  if (!isInstalledPackage()) {
    process.stderr.write(
      `This looks like a source/dev build (${fileURLToPath(import.meta.url)}).\n` +
        `\`gitm update\` only upgrades the published npm package. To update this checkout:\n` +
        `  git pull && npm install && npm run build && npm install -g ./packages/engine\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Updating ${NPM_PACKAGE} (current ${appVersion().version})…\n`);
  const res = await runNpm(["install", "-g", `${NPM_PACKAGE}@latest`]);
  if (res.code !== 0) {
    const notPublished = /E404|404 Not Found|No matching version|is not in (this|the npm) registry/i.test(
      res.stderr,
    );
    const perm = /EACCES|permission denied|EPERM/i.test(res.stderr);
    if (notPublished) {
      process.stderr.write(
        `\n${NPM_PACKAGE} isn't published to npm yet. Until it is, upgrade from a source ` +
          `checkout:\n  git pull && npm install && npm run build && npm install -g ./packages/engine\n`,
      );
    } else if (perm) {
      process.stderr.write(
        `\nnpm couldn't write the global package (permission denied). Re-run with the right ` +
          `privileges (e.g. sudo) or fix your npm prefix.\n`,
      );
    } else {
      process.stderr.write(`\nUpdate failed (npm exited ${res.code}).\n`);
    }
    process.exitCode = 1;
    return;
  }

  // Bounce a running background engine so the upgrade actually takes effect.
  // (Replacing the on-disk CLI doesn't restart an already-running process.)
  if (await isEngineRunning()) {
    process.stdout.write("Restarting the background engine…\n");
    await cmdStop();
    await delay(500); // let the port free
    await startBackground({ open: false });
  } else {
    process.stdout.write("Update complete. Start the engine with `gitm`.\n");
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
      "  gitm [start]                         Start the engine in the background (frees the terminal)",
      "  gitm start --foreground (-f)         Start the engine in the foreground (Ctrl-C to stop)",
      "  gitm open                            Open the UI (starts the engine in the background if needed)",
      "  gitm stop                            Stop the background engine",
      "  gitm update                          Upgrade the global CLI to the latest npm release + restart",
      "  gitm source add <path|url>           Add a source directory (or clone a URL)",
      "  gitm source list                     List source directories",
      "  gitm source remove <id>              Remove a source directory",
      "  gitm scan                            Re-scan all source directories",
      "  gitm repos                           List ingested repositories",
      "  gitm pr list [--repo <id|name>]      List pull requests",
      "  gitm pr create [--repo <id|name>] [--base <ref>] [--head <ref>] [--title <t>] [--description <d>] [--remote]",
      "                                   (inside a tracked repo, all flags are optional;",
      "                                    --remote also pushes & opens a PR on the forge via gh)",
      "  gitm pr view <pr-id>                 Show a PR and its review thread",
      "  gitm pr merge <pr-id>                Merge a PR (ff / merge-commit)",
      "  gitm pr close <pr-id>                Close a PR",
      "  gitm sync status                     Show backup backends, schedule, and remote manifest",
      "  gitm sync push [--repo <id|name>]    Back up repo(s) to object storage now",
      "  gitm sync pull <gm-id> [--into <d>]  Restore a repo from storage (clone, or fetch if present)",
      "  gitm sync config                     Show the storage config + how creds are sourced",
      "  gitm hook-event                      Internal: nudge agent refresh (used by hooks)",
      "",
      "Options:",
      "  --foreground, -f                     Run the engine in the foreground (with start)",
      "  --verbose                            Enable verbose logging to stderr",
      "",
      "Env:",
      "  GITMANAGER_PORT   Engine port (default 4317)",
      "  GITMANAGER_HOME   State dir (default ~/.gitmanager)",
      "  GITMANAGER_NO_OPEN  Never open a browser (overrides `gitm open`)",
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
  // When launched as a background engine, record our own pid now that the port
  // is bound — only the process that actually owns the port writes the pid file.
  if (process.env.GITMANAGER_BACKGROUND === "1") {
    try {
      fs.writeFileSync(pidPath(), String(process.pid));
    } catch {
      // non-fatal: `gitm stop` will fall back to its port check
    }
  }
  engine.ctx.agents.installHooks("gitm hook-event");
  process.stdout.write(
    [
      "",
      "  GitManager engine running in the foreground (loopback only)",
      `  ➜  ${engine.url}`,
      "  Token stored at ~/.gitmanager/token (injected into the served UI)",
      "  Open the UI with `gitm open`; Ctrl-C to stop.",
      "",
    ].join("\n") + "\n",
  );
  const shutdown = async (): Promise<void> => {
    await engine.close();
    // Remove the pid file if it points at us (set when launched in background).
    try {
      if (fs.readFileSync(pidPath(), "utf8").trim() === String(process.pid)) fs.rmSync(pidPath());
    } catch {
      // no pid file / already gone
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  let foreground = false;
  const allArgs = process.argv.slice(2).filter((a) => {
    if (a === "--verbose") { setVerbose(true); return false; }
    if (a === "--foreground" || a === "-f") { foreground = true; return false; }
    return true;
  });
  const [cmd, ...rest] = allArgs;

  switch (cmd) {
    case undefined:
    case "start":
      return foreground ? startServer() : startBackground({ open: false });
    case "open":
      return cmdOpen();
    case "stop":
      return cmdStop();
    case "update":
    case "upgrade":
      return cmdUpdate();
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
    case "sync":
      return cmdSync(rest);
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
