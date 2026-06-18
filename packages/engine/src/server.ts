import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { openDb } from "./db.js";
import { loadOrCreateToken } from "./token.js";
import { buildAllowedOrigins, registerSecurity } from "./security.js";
import { WsHub } from "./ws.js";
import { TerminalServer } from "./terminal.js";
import { AgentManager } from "./agents/manager.js";
import type { AppContext } from "./context.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerPrRoutes } from "./routes/prs.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerChatRoutes } from "./routes/chat.js";

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

/** Read index.html and inject the loopback token for the SPA to use. */
function injectedIndexHtml(uiDist: string, token: string): string | null {
  try {
    const html = fs.readFileSync(path.join(uiDist, "index.html"), "utf8");
    const tag = `<script>window.__GM_TOKEN__=${JSON.stringify(token)};</script>`;
    return html.includes("</head>")
      ? html.replace("</head>", `${tag}</head>`)
      : tag + html;
  } catch {
    return null;
  }
}

const PLACEHOLDER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>GitManager</title></head>
<body style="font-family:system-ui;background:#0d1117;color:#c9d1d9;padding:2rem">
<h1>GitManager engine is running</h1>
<p>The UI bundle was not found. Build it with <code>npm run build</code> and restart,
or run the dev server with <code>npm run dev:ui</code>.</p>
</body></html>`;

export async function startEngine(
  opts: { host?: string; port?: number } = {},
): Promise<EngineHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port =
    opts.port ?? (process.env.GITMANAGER_PORT ? Number(process.env.GITMANAGER_PORT) : 4317);

  const db = openDb();
  const token = loadOrCreateToken();
  const allowedOrigins = buildAllowedOrigins(host, port);

  const app = Fastify({ logger: false });

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

  registerSecurity(app, token, allowedOrigins);

  const hub = new WsHub(app.server, token, allowedOrigins);
  new TerminalServer(app.server, token, allowedOrigins, db);
  const agents = new AgentManager(db, hub);

  const ctx: AppContext = { db, hub, agents, token, allowedOrigins, host, port };

  // Health check (still behind auth + Origin).
  app.get("/api/ping", async () => ({ ok: true, version: "1.0.0" }));

  registerSourceRoutes(app, ctx);
  registerRepoRoutes(app, ctx);
  registerPrRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerChatRoutes(app, ctx);

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
  const indexHtml = uiDist
    ? injectedIndexHtml(uiDist, token) ?? PLACEHOLDER_HTML
    : PLACEHOLDER_HTML;

  // SPA fallback: any non-API GET serves the (token-injected) index.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api") && req.url !== "/ws") {
      reply.type("text/html").send(indexHtml);
      return;
    }
    reply.code(404).send({ error: "not_found" });
  });
  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(indexHtml);
  });

  // Bring up agent observation if it was previously enabled.
  agents.syncWithConfig();

  await app.listen({ host, port });
  const url = `http://${host}:${port}`;

  return {
    app,
    ctx,
    url,
    close: async () => {
      agents.disable();
      hub.close();
      await app.close();
      db.close();
    },
  };
}
