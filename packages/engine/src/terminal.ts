import { spawn as spawnPty } from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Database } from "better-sqlite3";
import { safeEqual } from "./token.js";

/**
 * node-pty ships a small `spawn-helper` binary (macOS/Linux). If it loses its
 * executable bit — which can happen when the engine is packed and globally
 * installed — `posix_spawn` fails with the opaque "posix_spawnp failed.".
 * Ensure it's executable once at startup. Best-effort; never throws.
 */
function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const ptyMain = require.resolve("node-pty");
    // ptyMain is .../node-pty/lib/index.js → root is two levels up.
    const root = path.resolve(path.dirname(ptyMain), "..");
    const candidates = [
      path.join(root, "build", "Release", "spawn-helper"),
      path.join(root, "build", "Debug", "spawn-helper"),
      path.join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    ];
    for (const helper of candidates) {
      if (!existsSync(helper)) continue;
      const mode = statSync(helper).mode;
      // Add execute bits for user/group/other if any are missing. This is the
      // common case: npm didn't preserve +x on the prebuilt spawn-helper.
      if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o755);
      // On macOS, also clear any Gatekeeper quarantine that would block exec.
      if (process.platform === "darwin") {
        try {
          execFileSync("xattr", ["-d", "com.apple.quarantine", helper], {
            stdio: "ignore",
          });
        } catch {
          // no quarantine attribute present — fine.
        }
      }
    }
  } catch {
    // node-pty layout differs or not resolvable — let the spawn surface it.
  }
}

/** Pick the first shell that exists, honoring $SHELL first. */
function resolveShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  const candidates = [
    process.env.SHELL,
    "/bin/zsh", // macOS default since Catalina
    "/bin/bash",
    "/bin/sh",
  ].filter((s): s is string => !!s);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "/bin/sh";
}

/**
 * node-pty fails with an opaque "posix_spawnp failed." when its native
 * spawn-helper can't run — almost always because the native module was built
 * for a different architecture/Node version than the one running the engine.
 * Turn that into something the user can act on.
 */
function explainSpawnError(err: unknown, shell: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/posix_spawn|spawn-helper|dlopen|invalid ELF|symbol/i.test(raw)) {
    return (
      `Could not start a terminal (${raw.trim()}).\n\n` +
      `This usually means node-pty's native module needs to be rebuilt for ` +
      `this machine. From the GitManager folder run:\n` +
      `  npm rebuild node-pty\n` +
      `  npm run build && npm install -g ./packages/engine\n\n` +
      `Tried shell: ${shell}`
    );
  }
  return `Could not start a terminal: ${raw}`;
}

interface RepoRow {
  abs_path: string;
}

/**
 * Handles /ws/terminal WebSocket upgrades. Each connection spawns a real PTY
 * (shell) in the repo's directory. I/O protocol:
 *   Client → Server binary: raw keyboard input
 *   Client → Server text JSON: {"type":"resize","cols":N,"rows":N}
 *   Server → Client binary: raw PTY output
 *   Server → Client text JSON: {"type":"exit","code":N}
 */
export class TerminalServer {
  private wss: WebSocketServer;

  constructor(
    server: Server,
    private token: string,
    private allowedOrigins: Set<string>,
    private db: Database,
  ) {
    ensureSpawnHelperExecutable();
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/ws/terminal") return;

      const origin = req.headers.origin;
      if (!origin || !this.allowedOrigins.has(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const provided = url.searchParams.get("token") ?? "";
      if (!provided || !safeEqual(provided, this.token)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const repoId = url.searchParams.get("repoId") ?? "";
      const row = this.db
        .prepare("SELECT abs_path FROM repos WHERE id = ?")
        .get(repoId) as RepoRow | undefined;
      if (!row) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket as never, head, (ws) => {
        this.attachPty(ws, row.abs_path);
      });
    });
  }

  private attachPty(ws: WebSocket, repoPath: string): void {
    // Resolve a working directory that actually exists (fall back to home).
    let cwd = repoPath;
    if (!existsSync(cwd)) cwd = homedir();

    const shell = resolveShell();

    let pty: ReturnType<typeof spawnPty>;
    try {
      pty = spawnPty(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      // node-pty throws synchronously on a bad native build / spawn failure.
      ws.send(JSON.stringify({ type: "error", message: explainSpawnError(err, shell) }));
      ws.close();
      return;
    }

    pty.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.from(data, "binary"));
      }
    });

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
        ws.close();
      }
    });

    ws.on("message", (msg: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        pty.write(Buffer.from(msg as Buffer).toString("binary"));
      } else {
        const text = msg.toString();
        try {
          const json = JSON.parse(text) as {
            type: string;
            cols?: number;
            rows?: number;
          };
          if (json.type === "resize" && json.cols && json.rows) {
            pty.resize(Math.max(1, json.cols), Math.max(1, json.rows));
          }
        } catch {
          // Not JSON — treat as raw input (e.g. paste from non-binary path)
          pty.write(text);
        }
      }
    });

    const cleanup = (): void => {
      try {
        pty.kill();
      } catch {}
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  close(): void {
    this.wss.close();
  }
}
