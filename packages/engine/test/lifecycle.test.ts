import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import {
  isolateHome,
  tmpDir,
  initRepo,
  writeAndCommit,
  createBranch,
  checkout,
} from "./helpers.js";
import { startEngine, type EngineHandle } from "../src/server.js";
import type { Pr, PrThreadEntry, Repo } from "../src/types.js";

interface Branch {
  name: string;
  sha: string;
  isHead: boolean;
}
interface PrDetail {
  pr: Pr;
  thread: PrThreadEntry[];
  repo: Repo | undefined;
}

const PORT = 4583;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let engine: EngineHandle;
let workspace: string;

// Force the review to take the graceful "skip" path (no claude in test env).
process.env.GITMANAGER_CLAUDE_BIN = "/nonexistent/claude-binary-for-tests";

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
  workspace = tmpDir("gm-ws-");
  engine = await startEngine({ port: PORT });
});

afterAll(async () => {
  await engine.close();
});

describe("full PR lifecycle (§9) over HTTP", () => {
  it("ingests repos from a source directory (idempotent)", async () => {
    const repo = await initRepo(path.join(workspace, "clean-repo"));
    await writeAndCommit(repo.path, "a.txt", "1", "c1");
    await createBranch(repo.path, "feature");
    await writeAndCommit(repo.path, "b.txt", "2", "c2");
    await checkout(repo.path, "main");

    const add = await call<{ scanned: number }>("POST", "/api/source-dirs", {
      path: workspace,
    });
    expect(add.status).toBe(200);

    const first = await call<Repo[]>("GET", "/api/repos");
    expect(first.body.length).toBe(1);

    // Re-scan is idempotent — still one repo with the same id.
    const idBefore = first.body[0].id;
    await call("POST", "/api/scan");
    const second = await call<Repo[]>("GET", "/api/repos");
    expect(second.body.length).toBe(1);
    expect(second.body[0].id).toBe(idBefore);
  });

  it("opens a PR, auto-reviews (skips cleanly w/o claude), and merges", async () => {
    const repos = await call<Repo[]>("GET", "/api/repos");
    const repo = repos.body.find((r) => r.display_name === "clean-repo")!;

    const created = await call<Pr>("POST", "/api/prs", {
      repo_id: repo.id,
      title: "Add b.txt",
      base_ref: "main",
      head_ref: "feature",
    });
    expect(created.status).toBe(200);
    const prId = created.body.id;
    expect(created.body.status).toBe("open");

    // The async review posts a skip notice (claude absent). Poll for it.
    let detail: PrDetail | null = null;
    for (let i = 0; i < 50; i++) {
      const d = await call<PrDetail>("GET", `/api/prs/${prId}`);
      if (d.body.thread.some((t) => t.kind === "review")) {
        detail = d.body;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(detail).not.toBeNull();
    const review = detail!.thread.find((t) => t.kind === "review")!;
    expect(review.body.toLowerCase()).toContain("skip");

    // Inline (file-anchored) comment persists its file/line anchor.
    await call("POST", `/api/prs/${prId}/comments`, {
      body: "nit: rename this",
      file_path: "b.txt",
      line: 3,
    });
    const withComment = await call<PrDetail>("GET", `/api/prs/${prId}`);
    const inline = withComment.body.thread.find((t) => t.file_path === "b.txt");
    expect(inline).toBeTruthy();
    expect(inline!.line).toBe(3);
    expect(inline!.author).toBe("user");

    // Merge → merged with a recorded SHA.
    const merged = await call<Pr>("POST", `/api/prs/${prId}/merge`);
    expect(merged.status).toBe(200);
    expect(merged.body.status).toBe("merged");
    expect(merged.body.merge_commit_sha).toBeTruthy();

    // Head branch deleted per default config.
    const branches = await call<Branch[]>("GET", `/api/repos/${repo.id}/branches`);
    expect(branches.body.some((b) => b.name === "feature")).toBe(false);
  });

  it("flags a conflicting merge and recovers after local resolution", async () => {
    const repo = await initRepo(path.join(workspace, "conflict-repo"));
    await writeAndCommit(repo.path, "f.txt", "base\n", "c1");
    await createBranch(repo.path, "feature");
    await writeAndCommit(repo.path, "f.txt", "feature\n", "c2");
    await checkout(repo.path, "main");
    await writeAndCommit(repo.path, "f.txt", "main\n", "c3");

    await call("POST", "/api/scan");
    const repos = await call<Repo[]>("GET", "/api/repos");
    const r = repos.body.find((x) => x.display_name === "conflict-repo")!;

    const pr = await call<Pr>("POST", "/api/prs", {
      repo_id: r.id,
      title: "Conflicting change",
      base_ref: "main",
      head_ref: "feature",
    });
    const prId = pr.body.id;

    const merge = await call<Pr>("POST", `/api/prs/${prId}/merge`);
    expect(merge.status).toBe(409);
    expect(merge.body.status).toBe("conflicted");

    // Resolve locally so head merges cleanly into main, then refresh → open.
    await checkout(repo.path, "feature");
    await writeAndCommit(repo.path, "f.txt", "main\n", "resolve");
    await checkout(repo.path, "main");

    const refreshed = await call<Pr>("POST", `/api/prs/${prId}/refresh`);
    expect(refreshed.body.status).toBe("open");
  });
});
