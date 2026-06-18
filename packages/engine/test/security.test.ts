import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { isolateHome } from "./helpers.js";
import { startEngine, type EngineHandle } from "../src/server.js";

const PORT = 4581;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let engine: EngineHandle;

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
