import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { earliestRootCommit, hasCommits } from "./git.js";

export interface RepoIdentity {
  id: string;
  /** How the id was derived — useful for diagnostics/tests. */
  source: "marker" | "root-commit" | "generated";
}

interface MarkerFile {
  id?: string;
}

function markerPath(repo: string): string {
  return path.join(repo, ".gitmanager");
}

function readMarker(repo: string): MarkerFile | null {
  try {
    const raw = fs.readFileSync(markerPath(repo), "utf8");
    return JSON.parse(raw) as MarkerFile;
  } catch {
    return null;
  }
}

function writeMarker(repo: string, id: string): void {
  const file = markerPath(repo);
  const existing = readMarker(repo) ?? {};
  const next = { ...existing, id };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
}

/**
 * Resolve a repo's stable cross-machine identity, deterministically and in
 * order (§8). Never changes an id once assigned. The marker file is created
 * only when no commit-based identity exists.
 */
export async function resolveIdentity(repo: string): Promise<RepoIdentity> {
  // 1. Existing marker wins, always.
  const marker = readMarker(repo);
  if (marker?.id) {
    return { id: marker.id, source: "marker" };
  }

  // 2. Root commit SHA if the repo has any history.
  if (await hasCommits(repo)) {
    const root = await earliestRootCommit(repo);
    if (root) {
      return { id: root, source: "root-commit" };
    }
  }

  // 3. No commits yet: mint a stable id and persist it in the repo.
  const id = `gm-${crypto.randomUUID()}`;
  writeMarker(repo, id);
  return { id, source: "generated" };
}
