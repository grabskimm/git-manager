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
import { getConfig } from "./config.js";

/**
 * node-pty ships a small `spawn-helper` binary (macOS/Linux). If it loses its
 * executable bit — or, on macOS, carries a Gatekeeper quarantine xattr after the
 * app is downloaded — `posix_spawn` fails with the opaque "posix_spawnp failed.".
 * Ensure it's executable and un-quarantined once at startup. Best-effort; never
 * throws.
 *
 * In a packaged Electron app the node-pty JS resolves *inside* `app.asar`, but
 * the native helper is unpacked to `app.asar.unpacked` — and that unpacked copy
 * is the one node-pty actually `exec`s (it applies the same `.asar`→`.asar.unpacked`
 * remap to its `helperPath`). So we must fix the unpacked file, not the virtual
 * one inside the archive; check both locations.
 */
function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const ptyMain = require.resolve("node-pty");
    // ptyMain is .../node-pty/lib/index.js; `..` from its dirname is the package
    // root (.../node-pty).
    const root = path.resolve(path.dirname(ptyMain), "..");
    const rels = [
      ["build", "Release", "spawn-helper"],
      ["build", "Debug", "spawn-helper"],
      ["prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"],
    ];
    const candidates = new Set<string>();
    for (const rel of rels) {
      const p = path.join(root, ...rel);
      candidates.add(p);
      // The path node-pty truly execs after its asar→unpacked remap.
      candidates.add(
        p
          .replace("app.asar", "app.asar.unpacked")
          .replace("node_modules.asar", "node_modules.asar.unpacked"),
      );
    }
    for (const helper of candidates) {
      // Per-candidate best-effort: a throw on one path (e.g. chmod on the
      // read-only in-asar virtual path) must not abort the loop before the real
      // app.asar.unpacked helper is reached.
      try {
        if (!existsSync(helper)) continue;
        const mode = statSync(helper).mode;
        // Add execute bits for user/group/other if any are missing, without
        // broadening read/write. This is the common case: npm/packaging didn't
        // preserve +x on the spawn-helper.
        if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o111);
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
      } catch {
        // this candidate isn't fixable (read-only/virtual) — try the next.
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

      // The terminal is a full shell (RCE by design), so it must honor the
      // `terminal_enabled` kill switch server-side — not just hide the UI tab.
      // Without this, any same-origin script (e.g. an XSS in rendered repo
      // content) could open a shell even when the user has disabled it.
      if (!getConfig(this.db).terminal_enabled) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const origin = req.headers.origin;
      if (!origin || !this.allowedOrigins.has(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const subproto = (req.headers["sec-websocket-protocol"] as string | undefined)
        ?.split(",")[0]
        ?.trim();
      const provided = url.searchParams.get("token") ?? subproto ?? "";
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
