import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { safeEqual } from "./token.js";

/**
 * Security floor (§7), enforced from the first endpoint:
 *  - Host allow-list on EVERY request (anti DNS-rebinding). A rebinding attack
 *    points a hostname the victim's browser trusts at 127.0.0.1, so the request
 *    arrives with the attacker's name in `Host`. Pinning `Host` to our own
 *    loopback authority rejects it — including for the token-bearing index.html
 *    and for GET /api calls that omit Origin, which the checks below let pass.
 *  - Bearer token auth on /api (rejects tokenless calls).
 *  - Origin allow-list on /api (blocks CSRF from any site the user visits —
 *    critical because the engine runs `git merge` and launches Claude).
 * Static UI assets are served without token auth (the token is injected into
 * the served HTML so the SPA can authenticate its API calls) but are still
 * Host-pinned, so a rebinding origin can never read the token out of the HTML.
 */
export function registerSecurity(
  app: FastifyInstance,
  token: string,
  allowedOrigins: Set<string>,
  allowedHosts: Set<string>,
): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // Host check first, on every route (incl. `/`, static assets, SPA fallback).
    // The Host header is mandatory in HTTP/1.1 and always sent by browsers; a
    // value that isn't our loopback authority can only be a cross-name (DNS
    // rebinding) request. A genuinely absent Host cannot come from a browser, so
    // it's left for the token/origin gate below to handle.
    const host = req.headers.host;
    if (host !== undefined && !allowedHosts.has(host)) {
      reply.code(403).send({ error: "forbidden_host" });
      return reply;
    }

    if (!req.url.startsWith("/api")) return;

    // Origin check (anti CSRF). A present Origin must match the engine's own
    // origin. State-changing requests must carry an allowed Origin: a real
    // same-origin browser call always sends one on POST/PUT/DELETE/PATCH, and
    // our CLI sets it explicitly, so a missing Origin there can only be a bypass
    // attempt. Safe (Origin-less) GET/HEAD stay token-only (and Host-pinned).
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

/** Loopback hostnames this engine answers to (the bound host plus aliases). */
function loopbackHostnames(host: string): Set<string> {
  return new Set([host, "127.0.0.1", "localhost", "[::1]"]);
}

/** Build the set of acceptable origins for this loopback engine. */
export function buildAllowedOrigins(host: string, port: number): Set<string> {
  const origins = new Set<string>();
  for (const h of loopbackHostnames(host)) {
    origins.add(`http://${h}:${port}`);
  }
  return origins;
}

/**
 * Acceptable `Host` header authorities (`host:port`). A DNS-rebinding request
 * carries the attacker's hostname here, so pinning to these values blocks it.
 * The engine only ever binds a non-default port, so the port is always present.
 */
export function buildAllowedHosts(host: string, port: number): Set<string> {
  const hosts = new Set<string>();
  for (const h of loopbackHostnames(host)) {
    hosts.add(`${h}:${port}`);
  }
  return hosts;
}
