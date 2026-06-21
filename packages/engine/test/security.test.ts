import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { isolateHome } from "./helpers.js";
import { startEngine, type EngineHandle } from "../src/server.js";
import { updateConfig } from "../src/config.js";

const PORT = 4581;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let engine: EngineHandle;

/** Raw HTTP request so we can spoof the Host header (fetch pins it to the URL). */
function rawRequest(
  pathname: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: pathname, method, headers },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Send a WebSocket upgrade and resolve with the resulting HTTP status. */
function rawUpgrade(
  pathWithQuery: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: PORT,
      path: pathWithQuery,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 101);
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  isolateHome();
  engine = await startEngine({ port: PORT });
});

afterAll(async () => {
  await engine.close();
});

describe("security floor (§7)", () => {
  it("rejects API calls with no token", async () => {
    const res = await fetch(`${ORIGIN}/api/ping`, { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(401);
  });

  it("rejects API calls with a wrong token", async () => {
    const res = await fetch(`${ORIGIN}/api/ping`, {
      headers: { Origin: ORIGIN, Authorization: "Bearer not-the-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects cross-origin calls even with a valid token", async () => {
    const res = await fetch(`${ORIGIN}/api/ping`, {
      headers: {
        Origin: "http://evil.example.com",
        Authorization: `Bearer ${engine.ctx.token}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("accepts an authenticated, same-origin call", async () => {
    const res = await fetch(`${ORIGIN}/api/ping`, {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${engine.ctx.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("binds loopback only", () => {
    expect(engine.ctx.host).toBe("127.0.0.1");
  });

  it("serves the SPA index without auth (token injected into HTML)", async () => {
    const res = await fetch(`${ORIGIN}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("__GM_TOKEN__");
  });
});

describe("Host pinning (anti DNS-rebinding)", () => {
  it("rejects a spoofed Host on the token-bearing index (no token leak)", async () => {
    const res = await rawRequest("/", { Host: `evil.example.com:${PORT}` });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("__GM_TOKEN__");
  });

  it("rejects a spoofed Host on /api even with a valid token and Origin", async () => {
    const res = await rawRequest("/api/ping", {
      Host: `evil.example.com:${PORT}`,
      Origin: ORIGIN,
      Authorization: `Bearer ${engine.ctx.token}`,
    });
    expect(res.status).toBe(403);
  });

  it("accepts a loopback Host alias (localhost) on the index", async () => {
    const res = await rawRequest("/", { Host: `localhost:${PORT}` });
    expect(res.status).toBe(200);
    expect(res.body).toContain("__GM_TOKEN__");
  });
});

describe("Content-Security-Policy", () => {
  it("serves a nonce'd script-src CSP whose nonce matches the token script", async () => {
    const res = await fetch(`${ORIGIN}/`);
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const m = /script-src 'self' 'nonce-([^']+)'/.exec(csp ?? "");
    expect(m).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(`<script nonce="${m![1]}">window.__GM_TOKEN__`);
  });
});

describe("terminal kill switch (terminal_enabled)", () => {
  const wsAuth = () => ({ Origin: ORIGIN });
  const wsPath = () => `/ws/terminal?token=${engine.ctx.token}&repoId=nope`;

  it("rejects the terminal upgrade when disabled (the default)", async () => {
    const status = await rawUpgrade(wsPath(), wsAuth());
    expect(status).toBe(403);
  });

  it("no longer rejects with 403 once enabled (gate passes to repo lookup → 404)", async () => {
    updateConfig(engine.ctx.db, { terminal_enabled: true });
    try {
      const status = await rawUpgrade(wsPath(), wsAuth());
      expect(status).toBe(404); // gate passed; unknown repoId is the next failure
    } finally {
      updateConfig(engine.ctx.db, { terminal_enabled: false });
    }
  });
});
