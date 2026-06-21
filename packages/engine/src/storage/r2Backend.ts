import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { StorageBackend } from "./backend.js";

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], input?: Buffer): Promise<CmdResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("wrangler", args, { stdio: ["pipe", "pipe", "pipe"] });
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
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function tmpFile(): string {
  return path.join(os.tmpdir(), `gm-r2-${crypto.randomBytes(6).toString("hex")}`);
}

/**
 * Cloudflare R2 backend via the `wrangler` CLI, so it uses the user's existing
 * `wrangler login` (OAuth) — no R2 access keys stored by GitManager. Requires
 * `wrangler` on PATH. Uses `--remote` so it hits real R2, not local state.
 */
export class R2Backend implements StorageBackend {
  readonly id = "r2";
  readonly label: string;

  constructor(private bucket: string) {
    this.label = `Cloudflare R2 (${bucket})`;
  }

  private ref(key: string): string {
    return `${this.bucket}/${key}`;
  }

  async isReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const res = await run(["--version"]);
    if (res.code !== 0) {
      return { ok: false, reason: "wrangler not found — install it and run `wrangler login`." };
    }
    const who = await run(["whoami"]);
    if (who.code !== 0) {
      return { ok: false, reason: "Not logged in to Cloudflare — run `wrangler login`." };
    }
    return { ok: true };
  }

  async put(key: string, data: Buffer): Promise<void> {
    const f = tmpFile();
    fs.writeFileSync(f, data);
    try {
      const res = await run(["r2", "object", "put", this.ref(key), "--file", f, "--remote"]);
      if (res.code !== 0) throw new Error(`wrangler r2 put failed: ${res.stderr.trim()}`);
    } finally {
      try {
        fs.rmSync(f);
      } catch {
        // best effort
      }
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const f = tmpFile();
    try {
      const res = await run(["r2", "object", "get", this.ref(key), "--file", f, "--remote"]);
      if (res.code !== 0) return null;
      return fs.existsSync(f) ? fs.readFileSync(f) : null;
    } finally {
      try {
        if (fs.existsSync(f)) fs.rmSync(f);
      } catch {
        // best effort
      }
    }
  }

  async del(key: string): Promise<void> {
    await run(["r2", "object", "delete", this.ref(key), "--remote"]);
  }
}
