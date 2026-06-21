import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isolateHome, initRepo, writeAndCommit } from "./helpers.js";
import {
  listTree,
  readFile,
  isRemoteUrl,
  repoNameFromUrl,
  runGit,
} from "../src/git.js";

beforeAll(() => {
  isolateHome();
});

describe("file browsing", () => {
  it("lists a tree with directories first, then files", async () => {
    const { path: repo } = await initRepo();
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "index.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(repo, "README.md"), "# Hi\n");
    await writeAndCommit(repo, "a.txt", "1", "c1");

    const root = await listTree(repo, "HEAD", "");
    const names = root.map((e) => `${e.type}:${e.name}`);
    expect(names).toContain("tree:src");
    expect(names).toContain("blob:README.md");
    // tree sorts before blob
    expect(root[0].type).toBe("tree");

    const sub = await listTree(repo, "HEAD", "src");
    expect(sub.map((e) => e.name)).toEqual(["index.ts"]);
  });

  it("reads a text file's contents at a ref", async () => {
    const { path: repo } = await initRepo();
    fs.writeFileSync(path.join(repo, "hello.txt"), "hello world\n");
    await writeAndCommit(repo, "hello.txt", "hello world\n", "c1");

    const file = await readFile(repo, "HEAD", "hello.txt");
    expect(file).not.toBeNull();
    expect(file!.binary).toBe(false);
    expect(file!.content).toContain("hello world");
  });

  it("flags binary files instead of returning bytes", async () => {
    const { path: repo } = await initRepo();
    await writeAndCommit(repo, "seed.txt", "1", "c1");
    // Write raw bytes (incl. NUL) and commit without overwriting.
    fs.writeFileSync(path.join(repo, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
    await runGit(repo, ["add", "bin.dat"]);
    await runGit(repo, ["commit", "-q", "-m", "binary"]);

    const file = await readFile(repo, "HEAD", "bin.dat");
    expect(file).not.toBeNull();
    expect(file!.binary).toBe(true);
    expect(file!.content).toBe("");
  });

  it("returns null for a missing file", async () => {
    const { path: repo } = await initRepo();
    await writeAndCommit(repo, "a.txt", "1", "c1");
    expect(await readFile(repo, "HEAD", "nope.txt")).toBeNull();
  });
});

describe("source URL handling", () => {
  it("recognizes remote URLs and scp-like syntax", () => {
    expect(isRemoteUrl("https://github.com/u/r.git")).toBe(true);
    expect(isRemoteUrl("git://host/r.git")).toBe(true);
    expect(isRemoteUrl("ssh://git@host/r.git")).toBe(true);
    expect(isRemoteUrl("file:///tmp/r.git")).toBe(true);
    expect(isRemoteUrl("git@github.com:u/r.git")).toBe(true);
  });

  it("treats local paths (incl. Windows) as non-URLs", () => {
    expect(isRemoteUrl("/home/you/projects")).toBe(false);
    expect(isRemoteUrl("~/code")).toBe(false);
    expect(isRemoteUrl("C:\\Users\\you\\projects")).toBe(false);
    expect(isRemoteUrl("./relative")).toBe(false);
  });

  it("derives a clean repo name from a URL", () => {
    expect(repoNameFromUrl("https://github.com/u/my-repo.git")).toBe("my-repo");
    expect(repoNameFromUrl("git@github.com:u/My.Repo.git")).toBe("My.Repo");
    expect(repoNameFromUrl("file:///tmp/path/to/repo.git/")).toBe("repo");
  });
});
