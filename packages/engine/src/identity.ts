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

// Stored inside .git/ so it is invisible to users and never appears in
// `git status`. The old location was `.gitmanager` at the repo root.
function markerPath(repo: string): string {
  return path.join(repo, ".git", "gitmanager");
}

// Legacy path — checked during migration only.
function legacyMarkerPath(repo: string): string {
  return path.join(repo, ".gitmanager");
}

function readMarkerAt(file: string): MarkerFile | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as MarkerFile;
  } catch {
    return null;
  }
}

function readMarker(repo: string): MarkerFile | null {
  // Prefer the new location; fall back to the old root-level file so existing
  // repos don't lose their identity on the first scan after an upgrade.
  return readMarkerAt(markerPath(repo)) ?? readMarkerAt(legacyMarkerPath(repo));
}

function writeMarker(repo: string, id: string): void {
  const file = markerPath(repo);
  const existing = readMarkerAt(file) ?? {};
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
