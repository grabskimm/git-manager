import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runGit, git } from "../git.js";

/** Create a `git bundle --all` of a repo and return its bytes. */
export async function createBundle(repoPath: string): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `gm-bundle-${crypto.randomBytes(6).toString("hex")}.bundle`);
  try {
    const res = await runGit(repoPath, ["bundle", "create", tmp, "--branches", "--tags"]);
    if (res.code !== 0) throw new Error(`git bundle failed: ${res.stderr.trim()}`);
    return fs.readFileSync(tmp);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp);
    } catch {
      // best effort
    }
  }
}

function withTempBundle<T>(data: Buffer, fn: (file: string) => Promise<T>): Promise<T> {
  const tmp = path.join(os.tmpdir(), `gm-restore-${crypto.randomBytes(6).toString("hex")}.bundle`);
  fs.writeFileSync(tmp, data);
  return fn(tmp).finally(() => {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp);
    } catch {
      // best effort
    }
  });
}

/** Clone a fresh repo from a bundle into `targetDir` (must not exist). */
export async function cloneFromBundle(data: Buffer, targetDir: string): Promise<void> {
  if (fs.existsSync(targetDir)) throw new Error(`target already exists: ${targetDir}`);
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  await withTempBundle(data, async (file) => {
    const res = await runGit(path.dirname(targetDir), ["clone", file, targetDir]);
    if (res.code !== 0) throw new Error(`git clone from bundle failed: ${res.stderr.trim()}`);
  });
}

/**
 * Non-destructively update an existing repo from a bundle: fetch all branches
 * into `refs/remotes/gm-backup/*` so nothing local is overwritten. The caller
 * can inspect/merge from there. Returns the refs that were updated.
 */
export async function fetchFromBundle(repoPath: string, data: Buffer): Promise<string[]> {
  return withTempBundle(data, async (file) => {
    const res = await runGit(repoPath, [
      "fetch",
      file,
      "+refs/heads/*:refs/remotes/gm-backup/*",
    ]);
    if (res.code !== 0) throw new Error(`git fetch from bundle failed: ${res.stderr.trim()}`);
    const refs = await runGit(repoPath, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/remotes/gm-backup",
    ]);
    return refs.stdout.split("\n").filter(Boolean);
  });
}

/** Best-effort HEAD sha for snapshot metadata. */
export async function headSha(repoPath: string): Promise<string | null> {
  try {
    return (await git(repoPath, ["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}
