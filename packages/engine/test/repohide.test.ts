import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { isolateHome, tmpDir, initRepo, writeAndCommit } from "./helpers.js";
import { startEngine, type EngineHandle } from "../src/server.js";
import type { Repo } from "../src/types.js";

const PORT = 4591;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let engine: EngineHandle;
let workspace: string;

async function call<T>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${ORIGIN}${p}`, {
    method,
    headers: {
      Origin: ORIGIN,
      Authorization: `Bearer ${engine.ctx.token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

beforeAll(async () => {
  isolateHome();
  workspace = tmpDir("gm-hide-ws-");
  engine = await startEngine({ port: PORT });

  // Seed two repos in the workspace.
  const r1 = await initRepo(path.join(workspace, "repo-alpha"));
  await writeAndCommit(r1.path, "a.txt", "1", "init");
  const r2 = await initRepo(path.join(workspace, "repo-beta"));
  await writeAndCommit(r2.path, "b.txt", "2", "init");

  await call("POST", "/api/source-dirs", { path: workspace });
});

afterAll(async () => {
  await engine.close();
});

describe("repo hide/show (§hide)", () => {
  it("GET /api/repos returns only visible repos by default", async () => {
    const { status, body } = await call<Repo[]>("GET", "/api/repos");
    expect(status).toBe(200);
    expect(body.length).toBe(2);
    expect(body.every((r) => r.hidden === false)).toBe(true);
  });

  it("PATCH /api/repos/:id hides a repo and it disappears from default list", async () => {
    const all = await call<Repo[]>("GET", "/api/repos");
    const target = all.body.find((r) => r.display_name === "repo-alpha")!;

    const patch = await call<Repo>("PATCH", `/api/repos/${target.id}`, { hidden: true });
    expect(patch.status).toBe(200);
    expect(patch.body.hidden).toBe(true);

    const visible = await call<Repo[]>("GET", "/api/repos");
    expect(visible.body.length).toBe(1);
    expect(visible.body[0].display_name).toBe("repo-beta");
  });

  it("GET /api/repos?all=true includes hidden repos", async () => {
    const { status, body } = await call<Repo[]>("GET", "/api/repos?all=true");
    expect(status).toBe(200);
    expect(body.length).toBe(2);
    const alpha = body.find((r) => r.display_name === "repo-alpha")!;
    expect(alpha.hidden).toBe(true);
    const beta = body.find((r) => r.display_name === "repo-beta")!;
    expect(beta.hidden).toBe(false);
  });

  it("PATCH /api/repos/:id restores a hidden repo to the default list", async () => {
    const all = await call<Repo[]>("GET", "/api/repos?all=true");
    const hidden = all.body.find((r) => r.hidden)!;

    const patch = await call<Repo>("PATCH", `/api/repos/${hidden.id}`, { hidden: false });
    expect(patch.status).toBe(200);
    expect(patch.body.hidden).toBe(false);

    const visible = await call<Repo[]>("GET", "/api/repos");
    expect(visible.body.length).toBe(2);
  });

  it("PATCH /api/repos/:id returns 404 for unknown id", async () => {
    const { status } = await call("PATCH", "/api/repos/nonexistent-id", { hidden: true });
    expect(status).toBe(404);
  });

  it("GET /api/repos/:id returns a hidden repo directly (no filtering on single-get)", async () => {
    const all = await call<Repo[]>("GET", "/api/repos?all=true");
    const target = all.body[0];

    await call("PATCH", `/api/repos/${target.id}`, { hidden: true });
    const { status, body } = await call<Repo>("GET", `/api/repos/${target.id}`);
    expect(status).toBe(200);
    expect(body.hidden).toBe(true);
  });
});
