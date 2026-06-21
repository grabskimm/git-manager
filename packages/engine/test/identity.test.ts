import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isolateHome, initRepo, writeAndCommit } from "./helpers.js";
import { resolveIdentity } from "../src/identity.js";
import { earliestRootCommit } from "../src/git.js";

beforeAll(() => {
  isolateHome();
});

describe("repo identity (§8)", () => {
  it("uses the root commit SHA for a repo with history", async () => {
    const { path: repo } = await initRepo();
    const root = await writeAndCommit(repo, "a.txt", "1", "first");
    await writeAndCommit(repo, "b.txt", "2", "second");

    const id = await resolveIdentity(repo);
    expect(id.source).toBe("root-commit");
    expect(id.id).toBe(root);
    expect(id.id).toBe(await earliestRootCommit(repo));
  });

  it("is stable across a copy to a different path (same id)", async () => {
    const { path: repo } = await initRepo();
    await writeAndCommit(repo, "a.txt", "1", "first");
    const a = await resolveIdentity(repo);

    // Copy the repo (including .git) to a new location.
    const copy = path.join(fs.mkdtempSync(path.join(repo, "..", "copy-")), "r");
    fs.cpSync(repo, copy, { recursive: true });
    const b = await resolveIdentity(copy);

    expect(b.id).toBe(a.id);
  });

  it("generates a gm- id and writes a marker for a repo with no commits", async () => {
    const { path: repo } = await initRepo();
    const id = await resolveIdentity(repo);
    expect(id.source).toBe("generated");
    expect(id.id.startsWith("gm-")).toBe(true);
    const marker = JSON.parse(fs.readFileSync(path.join(repo, ".gitmanager"), "utf8"));
    expect(marker.id).toBe(id.id);

    // Re-resolving reads the marker and never changes the id.
    const again = await resolveIdentity(repo);
    expect(again.source).toBe("marker");
    expect(again.id).toBe(id.id);
  });

  it("prefers an existing marker over the root commit", async () => {
    const { path: repo } = await initRepo();
    await writeAndCommit(repo, "a.txt", "1", "first");
    fs.writeFileSync(path.join(repo, ".gitmanager"), JSON.stringify({ id: "custom-id" }));
    const id = await resolveIdentity(repo);
    expect(id.source).toBe("marker");
    expect(id.id).toBe("custom-id");
  });

  it("ignores a path-traversal marker id and falls back to the root commit", async () => {
    const { path: repo } = await initRepo();
    const root = await writeAndCommit(repo, "a.txt", "1", "first");
    fs.writeFileSync(
      path.join(repo, ".gitmanager"),
      JSON.stringify({ id: "../../../../etc/passwd" }),
    );
    const id = await resolveIdentity(repo);
    expect(id.source).toBe("root-commit");
    expect(id.id).toBe(root);
  });

  it("ignores a marker id with path separators or other unsafe characters", async () => {
    for (const bad of ["a/b", "..", "x\\y", "id with space", "a;b"]) {
      const { path: repo } = await initRepo();
      await writeAndCommit(repo, "a.txt", "1", "first");
      fs.writeFileSync(path.join(repo, ".gitmanager"), JSON.stringify({ id: bad }));
      const id = await resolveIdentity(repo);
      expect(id.source).toBe("root-commit");
    }
  });
});
