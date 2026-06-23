import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

/**
 * All durable engine state lives under a single home directory.
 * Override with GITMANAGER_HOME (used by tests for isolation).
 */
export function gitmanagerHome(): string {
  const override = process.env.GITMANAGER_HOME;
  const home = override ? path.resolve(override) : path.join(os.homedir(), ".gitmanager");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

export function tokenPath(): string {
  return path.join(gitmanagerHome(), "token");
}

export function dbPath(): string {
  return path.join(gitmanagerHome(), "gitmanager.db");
}

/** PID of the background engine (written by `gitm start`, read by `gitm stop`). */
export function pidPath(): string {
  return path.join(gitmanagerHome(), "engine.pid");
}

/** Where a backgrounded engine's stdout/stderr are appended. */
export function logPath(): string {
  return path.join(gitmanagerHome(), "engine.log");
}

/**
 * The OS temp directory in canonical **long form**.
 *
 * On Windows `%TEMP%` is frequently exposed in legacy 8.3 short form when the
 * username is long — e.g. `C:\Users\MENDEL~1\AppData\Local\Temp` for the user
 * `MendelGrabski` (whereas `os.homedir()` reads `%USERPROFILE%` in long form,
 * which is why only tmpdir-derived paths are affected). Tools with path-safety
 * guards — including the `claude` agent we spawn into throwaway worktrees to
 * implement review suggestions — reject `~1`-style short paths, so the agent
 * could never edit files when its cwd was a short path.
 *
 * `realpathSync.native` asks the OS to expand short names to their long form
 * (and on macOS resolves the `/var`→`/private/var` symlink). Falls back to the
 * raw tmpdir if resolution ever fails so callers always get a usable path.
 */
export function canonicalTmpDir(): string {
  const base = os.tmpdir();
  try {
    return fs.realpathSync.native(base);
  } catch {
    return base;
  }
}

/**
 * A unique path inside the canonical temp dir: `<prefix>-<random><suffix>`.
 * Used for throwaway worktrees and bundle files so none of them inherit a
 * Windows 8.3 short path. Does not create anything on disk.
 */
export function tmpPath(prefix: string, suffix = ""): string {
  return path.join(canonicalTmpDir(), `${prefix}-${crypto.randomBytes(6).toString("hex")}${suffix}`);
}
