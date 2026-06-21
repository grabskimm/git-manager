import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { createLocalRepo, hasCommits, defaultBranch, isGitRepo } from "../src/git.js";
import { resolveIdentity } from "../src/identity.js";
import { tmpDir } from "./helpers.js";

describe("createLocalRepo", () => {
  it("inits a repo on main with a seeded initial commit", async () => {
    const dir = path.join(tmpDir("gm-new-"), "my-project");
    fs.mkdirSync(dir, { recursive: true });

    await createLocalRepo(dir, "my-project");

    expect(await isGitRepo(dir)).toBe(true);
    expect(await hasCommits(dir)).toBe(true);
    expect(await defaultBranch(dir)).toBe("main");
    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("# my-project");
  });

  it("produces a commit-based stable identity (not a generated marker)", async () => {
    const dir = path.join(tmpDir("gm-new-"), "ident");
    fs.mkdirSync(dir, { recursive: true });

    await createLocalRepo(dir, "ident");
    const id = await resolveIdentity(dir);

    expect(id.source).toBe("root-commit");
    expect(id.id).toMatch(/^[0-9a-f]{40}$/);
  });
});
