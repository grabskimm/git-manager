import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import { resolveIdentity } from "./identity.js";
import { defaultBranch } from "./git.js";
import { listSourceDirs, upsertRepo } from "./store.js";
import { debug } from "./logger.js";
import type { Repo } from "./types.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".cache",
  "vendor",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
]);

const MAX_DEPTH = 8;

/**
 * Walk a directory tree collecting repo work-tree roots. A directory holding a
 * `.git` entry is a repo root; we do not descend into it (avoids submodule and
 * worktree noise). Symlinks are not followed.
 */
function findRepoRoots(root: string): string[] {
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasGit = entries.some((e) => e.name === ".git");
    if (hasGit) {
      found.push(dir);
      return; // do not descend into a repo
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) {
        debug(`scan: skipping symlink ${path.join(dir, e.name)} (symlinks are not followed)`);
        continue;
      }
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  walk(root, 0);
  return found;
}

export interface ScanResult {
  scanned: number;
  repos: Repo[];
}

/** Scan one directory tree, resolving identity and persisting each repo. */
export async function scanSourceDir(db: DB, root: string): Promise<Repo[]> {
  const roots = findRepoRoots(path.resolve(root));
  const repos: Repo[] = [];
  for (const repoPath of roots) {
    try {
      const identity = await resolveIdentity(repoPath);
      const branch = await defaultBranch(repoPath);
      const repo = upsertRepo(db, {
        id: identity.id,
        display_name: path.basename(repoPath),
        abs_path: repoPath,
        default_branch: branch,
      });
      repos.push(repo);
    } catch {
      // A single bad repo never fails the whole scan.
    }
  }
  return repos;
}

/** Re-scan every configured source dir. Idempotent by repo identity. */
export async function scanAll(db: DB): Promise<ScanResult> {
  const dirs = listSourceDirs(db);
  const byId = new Map<string, Repo>();
  for (const dir of dirs) {
    const repos = await scanSourceDir(db, dir.path);
    for (const r of repos) byId.set(r.id, r);
  }
  return { scanned: dirs.length, repos: [...byId.values()] };
}
