import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { dbPath } from "./paths.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source_dirs (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  added_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  abs_path        TEXT NOT NULL,
  default_branch  TEXT,
  added_at        TEXT NOT NULL,
  last_scanned_at TEXT
);

CREATE TABLE IF NOT EXISTS prs (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  title         TEXT NOT NULL,
  description   TEXT,
  base_ref      TEXT NOT NULL,
  head_ref      TEXT NOT NULL,
  status        TEXT NOT NULL,
  merge_commit_sha TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  merged_at     TEXT
);

CREATE TABLE IF NOT EXISTS pr_thread (
  id         TEXT PRIMARY KEY,
  pr_id      TEXT NOT NULL REFERENCES prs(id),
  author     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL,
  file_path  TEXT,
  line       INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                  TEXT PRIMARY KEY,
  source              TEXT NOT NULL,
  repo_id             TEXT REFERENCES repos(id),
  branch              TEXT,
  pr_id               TEXT REFERENCES prs(id),
  status              TEXT NOT NULL,
  cwd                 TEXT,
  raw_transcript_path TEXT,
  started_at          TEXT,
  last_event_at       TEXT
);

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prs_repo ON prs(repo_id);
CREATE INDEX IF NOT EXISTS idx_thread_pr ON pr_thread(pr_id);
CREATE INDEX IF NOT EXISTS idx_sessions_repo ON agent_sessions(repo_id);
`;

const DEFAULT_CONFIG: Record<string, unknown> = {
  delete_head_on_merge: true,
  review_on_pr_open: true,
  agent_observe_enabled: false,
  chat_enabled: false,
  terminal_enabled: false,
};

export function openDb(file: string = dbPath()): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedConfig(db);
  return db;
}

function seedConfig(db: DB): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)",
  );
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      insert.run(key, JSON.stringify(value));
    }
  });
  tx();
}

export type { DB };
