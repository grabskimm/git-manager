import os from "node:os";
import path from "node:path";
import fs from "node:fs";

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
