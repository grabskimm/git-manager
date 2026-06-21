import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolateHome, initRepo, writeAndCommit } from "./helpers.js";
import { diffRange, diffStat, listTree, log, readFile, revParse } from "../src/git.js";

isolateHome();

/**
 * The read routes pass user-supplied refs/paths in `git` argument position. A
 * value starting with `-` (e.g. `--output=<file>`, honored by `git diff`/`git
 * show` as a file-write flag) must never be executed — the guards make these
 * functions fail closed instead.
 */
describe("git argument-injection guards", () => {
  it("does not execute --output smuggled in as a diff ref (no file write)", async () => {
    const { path: repo } = await initRepo();
    await writeAndCommit(repo, "a.txt", "1", "first");
    const target = path.join(os.tmpdir(), `gm-pwn-${Date.now()}-${Math.random()}.txt`);

    expect(await diffRange(repo, `--output=${target}`, "main")).toBe("");
    expect(await diffStat(repo, `--output=${target}`, "main")).toBe("");
    // Neither the bare path nor any glued-suffix variant was created.
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(os.tmpdir()).some((f) => f.startsWith(path.basename(target)))).toBe(
      false,
    );
  });

  it("treats option-like refs and paths as not-found", async () => {
    const { path: repo } = await initRepo();
    await writeAndCommit(repo, "a.txt", "1", "first");

    expect(await readFile(repo, "--output=/tmp/x", "a.txt")).toBeNull();
    expect(await readFile(repo, "main", "--output=/tmp/x")).toBeNull();
    expect(await listTree(repo, "-z")).toEqual([]);
    expect(await listTree(repo, "main", "--anything")).toEqual([]);
    expect(await log(repo, "--all")).toEqual([]);
    expect(await revParse(repo, "--output=/tmp/x")).toBeNull();
  });

  it("still reads legitimate refs and paths", async () => {
    const { path: repo } = await initRepo();
    await writeAndCommit(repo, "a.txt", "hello", "first");
    const file = await readFile(repo, "main", "a.txt");
    expect(file?.content).toBe("hello");
    expect((await listTree(repo, "main")).some((e) => e.name === "a.txt")).toBe(true);
    expect((await log(repo, "main")).length).toBeGreaterThan(0);
  });
});
