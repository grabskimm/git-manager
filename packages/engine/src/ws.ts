import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { safeEqual } from "./token.js";

export type WsEventType =
  | "review.start"
  | "review.token"
  | "review.done"
  | "review.skipped"
  | "pr.updated"
  | "pr.created"
  | "agent.updated"
  | "agents.refreshed"
  | "repos.updated"
  | "chat.start"
  | "chat.token"
  | "chat.done"
  | "chat.skipped";

export interface WsEvent {
  type: WsEventType;
  payload: unknown;
}

/**
 * Loopback WebSocket hub. The HTTP server's `upgrade` is handled manually so we
 * can enforce token + Origin auth before the socket is accepted (§7).
 */
export class WsHub {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();

  constructor(
    server: Server,
    private token: string,
    private allowedOrigins: Set<string>,
  ) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/ws") {
        // Not our path — let other upgrade handlers (e.g. terminal) deal with it.
        return;
      }

      // Origin check (blocks DNS-rebinding / cross-site upgrades). Browsers
      // always send Origin on a WebSocket handshake, so require an allowed one —
      // a missing Origin can only be a non-browser client trying to bypass it.
      const origin = req.headers.origin;
      if (!origin || !this.allowedOrigins.has(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      // Token via subprotocol header or query param (browsers cannot set
      // Authorization on WebSocket). `sec-websocket-protocol` is a
      // comma-separated list of offered subprotocols — take the first value.
      const subproto = (req.headers["sec-websocket-protocol"] as string | undefined)
        ?.split(",")[0]
        ?.trim();
      const provided = url.searchParams.get("token") ?? subproto ?? "";
      if (!provided || !safeEqual(provided, this.token)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.clients.add(ws);
        ws.on("close", () => this.clients.delete(ws));
        ws.on("error", () => this.clients.delete(ws));
      });
    });
  }

  broadcast(type: WsEventType, payload: unknown): void {
    const msg = JSON.stringify({ type, payload } satisfies WsEvent);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  close(): void {
    for (const ws of this.clients) ws.terminate();
    this.wss.close();
  }
}
