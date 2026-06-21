import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { StorageBackend } from "./backend.js";

/**
 * Local-filesystem backend: stores objects as files under a base directory
 * (handy for a mounted drive / NAS, and the fully-testable reference backend).
 * Keys map to nested paths under the base dir.
 */
export class FsBackend implements StorageBackend {
  readonly id = "fs";
  readonly label: string;
  private base: string;

  constructor(dir: string) {
    this.base = dir.startsWith("~")
      ? path.join(os.homedir(), dir.slice(1).replace(/^[/\\]/, ""))
      : path.resolve(dir);
    this.label = `Filesystem (${this.base})`;
  }

  async isReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      fs.mkdirSync(this.base, { recursive: true });
      fs.accessSync(this.base, fs.constants.W_OK);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `cannot write to ${this.base}: ${(e as Error).message}` };
    }
  }

  private full(key: string): string {
    // Defense-in-depth: never let a key (which embeds the repo id and prefix)
    // resolve outside the base dir, even if an upstream id/prefix validation is
    // ever bypassed. `path.resolve` collapses any `..` segments.
    const f = path.resolve(this.base, key);
    if (f !== this.base && !f.startsWith(this.base + path.sep)) {
      throw new Error(`storage key escapes base dir: ${key}`);
    }
    return f;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const f = this.full(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return fs.readFileSync(this.full(key));
    } catch {
      return null;
    }
  }

  async del(key: string): Promise<void> {
    try {
      fs.rmSync(this.full(key));
    } catch {
      // already gone
    }
  }
}
