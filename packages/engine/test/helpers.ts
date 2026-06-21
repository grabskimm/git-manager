import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runGit } from "../src/git.js";

export function tmpDir(prefix = "gm-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Isolate engine state (db + token) into a throwaway home for a test file. */
export function isolateHome(): string {
  const home = tmpDir("gm-home-");
  process.env.GITMANAGER_HOME = home;
  return home;
}

export interface TestRepo {
  path: string;
}

export async function initRepo(dir?: string): Promise<TestRepo> {
  const repo = dir ?? tmpDir("gm-repo-");
  fs.mkdirSync(repo, { recursive: true });
  await runGit(repo, ["init", "-q", "-b", "main"]);
  await runGit(repo, ["config", "user.email", "test@example.com"]);
  await runGit(repo, ["config", "user.name", "Test"]);
  await runGit(repo, ["config", "commit.gpgsign", "false"]);
  return { path: repo };
}

export async function writeAndCommit(
  repo: string,
  file: string,
  contents: string,
  message: string,
): Promise<string> {
  fs.writeFileSync(path.join(repo, file), contents);
  await runGit(repo, ["add", "."]);
  await runGit(repo, ["commit", "-q", "-m", message]);
  const sha = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
  return sha;
}

export async function createBranch(repo: string, name: string): Promise<void> {
  await runGit(repo, ["checkout", "-q", "-b", name]);
}

export async function checkout(repo: string, name: string): Promise<void> {
  await runGit(repo, ["checkout", "-q", name]);
}

export function rid(): string {
  return crypto.randomUUID();
}
