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

const isWin = process.platform === "win32";

/** Raw spawn of one command. On Windows, .cmd shims (npx/wrangler) need a shell. */
function rawRun(cmd: string, args: string[], input?: Buffer): Promise<CmdResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], shell: isWin });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr || String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input) child.stdin?.write(input);
    child.stdin?.end();
  });
}

// Resolve how to invoke wrangler once: explicit override, then a global
// `wrangler`, then `npx wrangler` (the common case — wrangler run via npx).
let resolvedBase: string[] | null = null;
async function wranglerBase(): Promise<string[] | null> {
  if (resolvedBase) return resolvedBase;
  const candidates: string[][] = [];
  const override = process.env.GITMANAGER_WRANGLER;
  if (override) candidates.push(override.split(" ").filter(Boolean));
  candidates.push(["wrangler"]);
  candidates.push(["npx", "wrangler"]);
  for (const base of candidates) {
    const res = await rawRun(base[0], [...base.slice(1), "--version"]);
    if (res.code === 0) {
      resolvedBase = base;
      return base;
    }
  }
  return null;
}

function tmpFile(): string {
  return path.join(os.tmpdir(), `gm-r2-${crypto.randomBytes(6).toString("hex")}`);
}

/**
 * Cloudflare R2 backend via the `wrangler` CLI, so it uses the user's existing
 * `wrangler login` (OAuth) — no R2 access keys stored by GitManager. Resolves
 * `wrangler` from PATH or falls back to `npx wrangler` (override with
 * GITMANAGER_WRANGLER). Uses `--remote` so it hits real R2, not local state.
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

  private async run(args: string[], input?: Buffer): Promise<CmdResult> {
    const base = await wranglerBase();
    if (!base) {
      return {
        code: -1,
        stdout: "",
        stderr: "wrangler not found (tried `wrangler` and `npx wrangler`)",
      };
    }
    return rawRun(base[0], [...base.slice(1), ...args], input);
  }

  async isReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const base = await wranglerBase();
    if (!base) {
      return {
        ok: false,
        reason:
          "wrangler not found. Ensure `npx wrangler` works (or set GITMANAGER_WRANGLER), then run `npx wrangler login`.",
      };
    }
    // Readiness is "wrangler is invokable" — we don't gate on `whoami`, which is
    // unreliable (false negatives even when r2 operations work). Auth problems
    // surface as the real wrangler error on push, which is reported per-backend.
    return { ok: true };
  }

  /** The resolved invocation (e.g. "npx wrangler"), for messages. */
  async invocation(): Promise<string> {
    return (await wranglerBase())?.join(" ") ?? "wrangler";
  }

  async put(key: string, data: Buffer): Promise<void> {
    const f = tmpFile();
    fs.writeFileSync(f, data);
    try {
      const res = await this.run(["r2", "object", "put", this.ref(key), "--file", f, "--remote"]);
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
      const res = await this.run(["r2", "object", "get", this.ref(key), "--file", f, "--remote"]);
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
    await this.run(["r2", "object", "delete", this.ref(key), "--remote"]);
  }
}
