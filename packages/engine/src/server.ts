import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { openDb } from "./db.js";
import { gitUserName } from "./git.js";
import { loadOrCreateToken } from "./token.js";
import { buildAllowedHosts, buildAllowedOrigins, registerSecurity } from "./security.js";
import { WsHub } from "./ws.js";
import { TerminalServer } from "./terminal.js";
import { AgentManager } from "./agents/manager.js";
import { SyncScheduler } from "./storage/scheduler.js";
import type { AppContext } from "./context.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerPrRoutes } from "./routes/prs.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { log, debug, isVerbose } from "./logger.js";
import { appVersion } from "./version.js";

export interface EngineHandle {
  app: FastifyInstance;
  ctx: AppContext;
  url: string;
  close: () => Promise<void>;
}

function resolveUiDist(): string | null {
  if (process.env.GITMANAGER_UI_DIST) return process.env.GITMANAGER_UI_DIST;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "ui"), // bundled into dist/ui (global install)
    path.resolve(here, "../../ui/dist"), // dist/ -> packages/ui/dist (dev)
    path.resolve(here, "../../../ui/dist"),
    path.resolve(here, "../ui/dist"),
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, "index.html"))) ?? null;
}

/** Read index.html and inject the loopback token for the SPA to use. The token
 * script carries the CSP nonce so it runs under a strict `script-src`. */
function injectedIndexHtml(uiDist: string, token: string, nonce: string): string | null {
  try {
    const html = fs.readFileSync(path.join(uiDist, "index.html"), "utf8");
    const tag = `<script nonce="${nonce}">window.__GM_TOKEN__=${JSON.stringify(token)};</script>`;
    return html.includes("</head>")
      ? html.replace("</head>", `${tag}</head>`)
      : tag + html;
  } catch {
    return null;
  }
}

/**
 * Content-Security-Policy for the served HTML (defense-in-depth backstop for the
 * sanitizers in the UI). Scripts are limited to our own bundle plus the
 * nonce'd token tag (no `unsafe-inline`), and `connect-src 'self'` stops any
 * script that does slip through from exfiltrating the loopback token to an
 * external origin. `frame-ancestors 'none'` blocks clickjacking.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const PLACEHOLDER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>GitManager</title></head>
<body style="font-family:system-ui;background:#0d1117;color:#c9d1d9;padding:2rem">
<h1>GitManager engine is running</h1>
<p>The UI bundle was not found. Build it with <code>npm run build</code> and restart,
or run the dev server with <code>npm run dev:ui</code>.</p>
</body></html>`;

/** Parse GITMANAGER_PORT, ignoring blank/non-numeric/out-of-range values. */
function envPort(): number | null {
  const raw = process.env.GITMANAGER_PORT;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    log(`ignoring invalid GITMANAGER_PORT="${raw}" — using the default port`);
    return null;
  }
  return n;
}

export async function startEngine(
  opts: { host?: string; port?: number } = {},
): Promise<EngineHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? envPort() ?? 4317;

  const db = openDb();
  const token = loadOrCreateToken();
  const allowedOrigins = buildAllowedOrigins(host, port);
  const allowedHosts = buildAllowedHosts(host, port);

  const app = Fastify({ logger: false });

  if (isVerbose()) {
    app.addHook("onResponse", (req, reply, done) => {
      debug(`${req.method} ${req.url} → ${reply.statusCode} (${Math.round(reply.elapsedTime)}ms)`);
      done();
    });
  }

  // Many endpoints are bodyless POSTs (merge, close, scan…). Browsers and our
  // client still send `Content-Type: application/json`, so treat an empty body
  // as an empty object instead of rejecting it.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const text = (body as string).trim();
      if (!text) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  registerSecurity(app, token, allowedOrigins, allowedHosts);

  const hub = new WsHub(app.server, token, allowedOrigins);
  new TerminalServer(app.server, token, allowedOrigins, db);
  // Catch-all: WsHub and TerminalServer each handle only their own path and
  // return for anything else, which would otherwise leave the upgrade socket
  // open forever. Registered last so the owners get first refusal; this only
  // fires for paths neither claimed.
  const KNOWN_UPGRADE_PATHS = new Set(["/ws", "/ws/terminal"]);
  app.server.on("upgrade", (req, socket) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (KNOWN_UPGRADE_PATHS.has(pathname)) return;
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });
  const agents = new AgentManager(db, hub);
  const sync = new SyncScheduler(db);

  const ctx: AppContext = { db, hub, agents, sync, token, allowedOrigins, host, port };

  // Health check (still behind auth + Origin). Version is sourced from the
  // single source of truth in version.ts.
  app.get("/api/ping", async () => ({ ok: true, ...appVersion() }));

  // Unauthenticated readiness probe. It lives outside `/api`, so it skips the
  // token + Origin gate (it leaks nothing sensitive) while still being
  // Host-pinned against DNS-rebinding. The desktop shell polls this to know
  // when the engine is ready to receive the webview, and it doubles as the
  // version surface for the shell's "about"/update logic.
  app.get("/healthz", async (_req, reply) => {
    reply.header("Cache-Control", "no-store").send({ ok: true, ...appVersion() });
  });

  // Current user's display name (git config user.name, else OS account).
  app.get("/api/me", async () => ({ name: await gitUserName() }));

  registerSourceRoutes(app, ctx);
  registerRepoRoutes(app, ctx);
  registerPrRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerSyncRoutes(app, ctx);

  // Static UI on the same loopback origin.
  const uiDist = resolveUiDist();
  if (uiDist) {
    await app.register(fastifyStatic, {
      root: uiDist,
      prefix: "/",
      wildcard: false,
      index: false,
    });
  }
  const cspNonce = crypto.randomBytes(16).toString("base64");
  const csp = contentSecurityPolicy(cspNonce);
  const indexHtml = uiDist
    ? injectedIndexHtml(uiDist, token, cspNonce) ?? PLACEHOLDER_HTML
    : PLACEHOLDER_HTML;

  // SPA fallback: any non-API GET serves the (token-injected) index.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api") && req.url !== "/ws") {
      reply.header("Content-Security-Policy", csp).type("text/html").send(indexHtml);
      return;
    }
    reply.code(404).send({ error: "not_found" });
  });
  app.get("/", async (_req, reply) => {
    reply.header("Content-Security-Policy", csp).type("text/html").send(indexHtml);
  });

  // Bring up agent observation and the backup schedule if previously enabled.
  agents.syncWithConfig();
  sync.syncWithConfig();

  await app.listen({ host, port });
  const url = `http://${host}:${port}`;
  log(`engine listening on ${url}`);

  return {
    app,
    ctx,
    url,
    close: async () => {
      log("engine shutting down");
      agents.disable();
      sync.stop();
      hub.close();
      await app.close();
      db.close();
    },
  };
}
