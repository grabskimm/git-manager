import { spawn as spawnPty } from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Database } from "better-sqlite3";
import { safeEqual } from "./token.js";

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
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/ws/terminal") return;

      const origin = req.headers.origin;
      if (origin && !this.allowedOrigins.has(origin)) {
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

  private attachPty(ws: WebSocket, cwd: string): void {
    const shell =
      process.env.SHELL ||
      (process.platform === "win32" ? "cmd.exe" : "/bin/bash");

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
      ws.send(JSON.stringify({ type: "error", message: String(err) }));
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
