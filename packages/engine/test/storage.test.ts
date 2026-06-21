import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runGit } from "../src/git.js";
import { FsBackend } from "../src/storage/fsBackend.js";
import { pushRepo, pullRepo, readManifest, type RepoLike } from "../src/storage/sync.js";
import type { BackendConfig } from "../src/storage/backend.js";

let tmp: string;

async function makeRepo(dir: string, file: string, content: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  await runGit(dir, ["init", "-q"]);
  await runGit(dir, ["config", "user.email", "t@t.local"]);
  await runGit(dir, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(dir, file), content);
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["commit", "-q", "-m", "init"]);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gm-storage-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("storage sync (filesystem backend round-trip)", () => {
  it("pushes a bundle, writes manifest, and restores via clone", async () => {
    const repoDir = path.join(tmp, "src-repo");
    await makeRepo(repoDir, "hello.txt", "hi there");

    const repo: RepoLike = {
      id: "gm-" + crypto.randomUUID(),
      display_name: "src-repo",
      abs_path: repoDir,
      default_branch: "main",
    };
    const backends: BackendConfig[] = [
      { id: "fs", enabled: true, dir: path.join(tmp, "bucket"), prefix: "gitmanager" },
    ];

    const results = await pushRepo(backends, repo);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
    expect(results[0].bytes).toBeGreaterThan(0);

    // Manifest lists the repo.
    const manifest = await readManifest(backends);
    expect(manifest?.manifest.repos[repo.id]?.name).toBe("src-repo");

    // Restore onto a fresh device (clone into a new dir).
    const into = path.join(tmp, "restored");
    const pull = await pullRepo(backends, repo.id, { intoDir: into });
    expect(pull.status).toBe("cloned");
    expect(fs.existsSync(path.join(pull.path!, "hello.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(pull.path!, "hello.txt"), "utf8")).toBe("hi there");
  });

  it("prunes to the latest snapshots and keeps a working latest", async () => {
    const repoDir = path.join(tmp, "r");
    await makeRepo(repoDir, "a.txt", "v0");
    const repo: RepoLike = {
      id: "gm-prune",
      display_name: "r",
      abs_path: repoDir,
      default_branch: "main",
    };
    const backends: BackendConfig[] = [
      { id: "fs", enabled: true, dir: path.join(tmp, "bucket2"), prefix: "gm" },
    ];

    // 12 pushes; index keeps at most 10 snapshots.
    for (let i = 1; i <= 12; i++) {
      fs.writeFileSync(path.join(repoDir, "a.txt"), `v${i}`);
      await runGit(repoDir, ["commit", "-qam", `v${i}`]);
      await pushRepo(backends, repo);
    }
    const idxBuf = await new FsBackend(path.join(tmp, "bucket2")).get("gm/repos/gm-prune/index.json");
    const idx = JSON.parse(idxBuf!.toString()) as { snapshots: unknown[]; latest: string };
    expect(idx.snapshots.length).toBeLessThanOrEqual(10);

    // Latest still restorable with newest content.
    const pull = await pullRepo(backends, "gm-prune", { intoDir: path.join(tmp, "out") });
    expect(pull.status).toBe("cloned");
    expect(fs.readFileSync(path.join(pull.path!, "a.txt"), "utf8")).toBe("v12");
  });

  it("reports skip when no backend is configured", async () => {
    const repo: RepoLike = { id: "x", display_name: "x", abs_path: tmp, default_branch: null };
    const res = await pushRepo([], repo);
    expect(res[0].status).toBe("skipped");
  });
});
