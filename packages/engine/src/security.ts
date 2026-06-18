import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { safeEqual } from "./token.js";

/**
 * Security floor (§7), enforced on every /api route from the first endpoint:
 *  - Bearer token auth (rejects tokenless calls).
 *  - Origin allow-list (blocks DNS-rebinding / CSRF from any site the user
 *    visits — critical because the engine runs `git merge` and launches Claude).
 * Static UI assets are served without auth; the token is injected into the
 * served HTML so the SPA can authenticate its API calls.
 */
export function registerSecurity(
  app: FastifyInstance,
  token: string,
  allowedOrigins: Set<string>,
): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api")) return;

    // Origin check (anti DNS-rebinding / CSRF). A present Origin must match the
    // engine's own origin. State-changing requests must carry an allowed Origin:
    // a real same-origin browser call always sends one on POST/PUT/DELETE/PATCH,
    // and our CLI sets it explicitly, so a missing Origin there can only be a
    // bypass attempt. Safe (Origin-less) GET/HEAD stay token-only.
    const origin = req.headers.origin;
    const method = req.method.toUpperCase();
    const stateChanging = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    if (origin ? !allowedOrigins.has(origin) : stateChanging) {
      reply.code(403).send({ error: "forbidden_origin" });
      return reply;
    }

    const auth = req.headers.authorization ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!provided || !safeEqual(provided, token)) {
      reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
  });
}

/** Build the set of acceptable origins for this loopback engine. */
export function buildAllowedOrigins(host: string, port: number): Set<string> {
  const hosts = new Set([host, "127.0.0.1", "localhost", "[::1]"]);
  const origins = new Set<string>();
  for (const h of hosts) {
    origins.add(`http://${h}:${port}`);
  }
  return origins;
}
