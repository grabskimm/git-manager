import crypto from "node:crypto";
import type { DB } from "./db.js";
import { debug } from "./logger.js";
import type {
  AgentSessionRow,
  AgentStatus,
  Pr,
  PrStatus,
  PrThreadEntry,
  Repo,
  SourceDir,
  ThreadAuthor,
  ThreadKind,
} from "./types.js";

const now = (): string => new Date().toISOString();
const uuid = (): string => crypto.randomUUID();

// ---- source_dirs ----

export function listSourceDirs(db: DB): SourceDir[] {
  return db
    .prepare("SELECT * FROM source_dirs ORDER BY added_at")
    .all() as SourceDir[];
}

export function addSourceDir(db: DB, p: string): SourceDir {
  const row: SourceDir = { id: uuid(), path: p, added_at: now() };
  db.prepare(
    "INSERT INTO source_dirs (id, path, added_at) VALUES (@id, @path, @added_at)",
  ).run(row);
  debug(`store: addSourceDir id=${row.id} path=${p}`);
  return row;
}

export function removeSourceDir(db: DB, id: string): void {
  db.prepare("DELETE FROM source_dirs WHERE id = ?").run(id);
  debug(`store: removeSourceDir id=${id}`);
}

// ---- repos ----

// SQLite stores booleans as INTEGER (0/1); coerce at the store boundary so
// callers always see a real JS boolean in Repo.hidden.
type RawRepoRow = Omit<Repo, "hidden"> & { hidden: number };
function coerceRepo(row: unknown): Repo {
  const r = row as RawRepoRow;
  return { ...r, hidden: Boolean(r.hidden) };
}

export function listRepos(db: DB): Repo[] {
  return db
    .prepare("SELECT * FROM repos ORDER BY display_name COLLATE NOCASE")
    .all()
    .map(coerceRepo);
}

export function listVisibleRepos(db: DB): Repo[] {
  return db
    .prepare("SELECT * FROM repos WHERE hidden = 0 ORDER BY display_name COLLATE NOCASE")
    .all()
    .map(coerceRepo);
}

export function getRepo(db: DB, id: string): Repo | undefined {
  const row = db.prepare("SELECT * FROM repos WHERE id = ?").get(id);
  return row ? coerceRepo(row) : undefined;
}

export function setRepoHidden(db: DB, id: string, hidden: boolean): void {
  db.prepare("UPDATE repos SET hidden = ? WHERE id = ?").run(hidden ? 1 : 0, id);
  debug(`store: setRepoHidden id=${id} hidden=${hidden}`);
}

export function upsertRepo(
  db: DB,
  repo: {
    id: string;
    display_name: string;
    abs_path: string;
    default_branch: string | null;
  },
): Repo {
  const existing = getRepo(db, repo.id);
  if (existing) {
    db.prepare(
      `UPDATE repos
         SET display_name = @display_name,
             abs_path = @abs_path,
             default_branch = @default_branch,
             last_scanned_at = @ts
       WHERE id = @id`,
    ).run({ ...repo, ts: now() });
    debug(`store: upsertRepo update id=${repo.id} name=${repo.display_name}`);
  } else {
    db.prepare(
      `INSERT INTO repos (id, display_name, abs_path, default_branch, added_at, last_scanned_at)
       VALUES (@id, @display_name, @abs_path, @default_branch, @ts, @ts)`,
    ).run({ ...repo, ts: now() });
    debug(`store: upsertRepo insert id=${repo.id} name=${repo.display_name}`);
  }
  return getRepo(db, repo.id)!;
}

// ---- prs ----

export function listPrs(db: DB, repoId?: string): Pr[] {
  if (repoId) {
    return db
      .prepare("SELECT * FROM prs WHERE repo_id = ? ORDER BY created_at DESC")
      .all(repoId) as Pr[];
  }
  return db.prepare("SELECT * FROM prs ORDER BY created_at DESC").all() as Pr[];
}

export function getPr(db: DB, id: string): Pr | undefined {
  return db.prepare("SELECT * FROM prs WHERE id = ?").get(id) as Pr | undefined;
}

export function findOpenPrByHead(
  db: DB,
  repoId: string,
  headRef: string,
): Pr | undefined {
  return db
    .prepare(
      "SELECT * FROM prs WHERE repo_id = ? AND head_ref = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1",
    )
    .get(repoId, headRef) as Pr | undefined;
}

export function createPr(
  db: DB,
  input: {
    repo_id: string;
    title: string;
    description: string | null;
    base_ref: string;
    head_ref: string;
  },
): Pr {
  const ts = now();
  const row: Pr = {
    id: uuid(),
    repo_id: input.repo_id,
    title: input.title,
    description: input.description,
    base_ref: input.base_ref,
    head_ref: input.head_ref,
    status: "open",
    merge_commit_sha: null,
    created_at: ts,
    updated_at: ts,
    merged_at: null,
    remote_url: null,
  };
  db.prepare(
    `INSERT INTO prs (id, repo_id, title, description, base_ref, head_ref, status, merge_commit_sha, created_at, updated_at, merged_at, remote_url)
     VALUES (@id, @repo_id, @title, @description, @base_ref, @head_ref, @status, @merge_commit_sha, @created_at, @updated_at, @merged_at, @remote_url)`,
  ).run(row);
  debug(`store: createPr id=${row.id} repo=${row.repo_id} ${row.head_ref}->${row.base_ref}`);
  return row;
}

/** Record the remote PR URL on a local PR after it's opened on the forge. */
export function setPrRemoteUrl(db: DB, id: string, url: string): void {
  db.prepare("UPDATE prs SET remote_url=?, updated_at=? WHERE id=?").run(url, now(), id);
  debug(`store: setPrRemoteUrl id=${id}`);
}

export function updatePr(
  db: DB,
  id: string,
  patch: Partial<
    Pick<Pr, "status" | "merge_commit_sha" | "merged_at" | "title" | "description">
  >,
): Pr {
  const current = getPr(db, id);
  if (!current) throw new Error(`PR not found: ${id}`);
  const next: Pr = { ...current, ...patch, updated_at: now() };
  db.prepare(
    `UPDATE prs SET title=@title, description=@description, status=@status,
       merge_commit_sha=@merge_commit_sha, updated_at=@updated_at, merged_at=@merged_at
     WHERE id=@id`,
  ).run(next);
  debug(`store: updatePr id=${id} status=${next.status}`);
  return next;
}

// ---- pr_thread ----

export function listThread(db: DB, prId: string): PrThreadEntry[] {
  return db
    .prepare("SELECT * FROM pr_thread WHERE pr_id = ? ORDER BY created_at")
    .all(prId) as PrThreadEntry[];
}

export function addThreadEntry(
  db: DB,
  entry: {
    pr_id: string;
    author: ThreadAuthor;
    kind: ThreadKind;
    body: string;
    file_path?: string | null;
    line?: number | null;
  },
): PrThreadEntry {
  const row: PrThreadEntry = {
    id: uuid(),
    pr_id: entry.pr_id,
    author: entry.author,
    kind: entry.kind,
    body: entry.body,
    file_path: entry.file_path ?? null,
    line: entry.line ?? null,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO pr_thread (id, pr_id, author, kind, body, file_path, line, created_at)
     VALUES (@id, @pr_id, @author, @kind, @body, @file_path, @line, @created_at)`,
  ).run(row);
  debug(`store: addThreadEntry id=${row.id} pr=${row.pr_id} kind=${row.kind} author=${row.author}`);
  return row;
}

// ---- agent_sessions ----

export function listSessions(db: DB): AgentSessionRow[] {
  return db
    .prepare("SELECT * FROM agent_sessions ORDER BY last_event_at DESC")
    .all() as AgentSessionRow[];
}

export function upsertSession(db: DB, row: AgentSessionRow): void {
  db.prepare(
    `INSERT INTO agent_sessions (id, source, repo_id, branch, pr_id, status, cwd, raw_transcript_path, started_at, last_event_at)
     VALUES (@id, @source, @repo_id, @branch, @pr_id, @status, @cwd, @raw_transcript_path, @started_at, @last_event_at)
     ON CONFLICT(id) DO UPDATE SET
       source=excluded.source, repo_id=excluded.repo_id, branch=excluded.branch,
       pr_id=excluded.pr_id, status=excluded.status, cwd=excluded.cwd,
       raw_transcript_path=excluded.raw_transcript_path,
       started_at=excluded.started_at, last_event_at=excluded.last_event_at`,
  ).run(row);
  debug(`store: upsertSession id=${row.id} status=${row.status} source=${row.source}`);
}

export function markStaleSessionsDone(
  db: DB,
  activeIds: string[],
  status: AgentStatus = "done",
): void {
  const sessions = listSessions(db);
  const active = new Set(activeIds);
  const upd = db.prepare(
    "UPDATE agent_sessions SET status = ? WHERE id = ? AND status != 'done'",
  );
  for (const s of sessions) {
    if (!active.has(s.id)) {
      upd.run(status, s.id);
      debug(`store: markStaleSessionsDone id=${s.id} → ${status}`);
    }
  }
}

export { uuid, now, type PrStatus };
