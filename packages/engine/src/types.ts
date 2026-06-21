// Shared domain types used across the engine and mirrored by the UI client.

export interface SourceDir {
  id: string;
  path: string;
  added_at: string;
}

export interface Repo {
  id: string;
  display_name: string;
  abs_path: string;
  default_branch: string | null;
  added_at: string;
  last_scanned_at: string | null;
}

export type PrStatus = "open" | "merged" | "conflicted" | "closed";

export interface Pr {
  id: string;
  repo_id: string;
  title: string;
  description: string | null;
  base_ref: string;
  head_ref: string;
  status: PrStatus;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  remote_url: string | null;
}

export type ThreadAuthor = "claude" | "user" | "system";
export type ThreadKind = "review" | "comment" | "status_change";

export interface PrThreadEntry {
  id: string;
  pr_id: string;
  author: ThreadAuthor;
  kind: ThreadKind;
  body: string;
  file_path: string | null;
  line: number | null;
  created_at: string;
}

export type AgentStatus = "running" | "waiting" | "idle" | "done";

export interface AgentSessionRow {
  id: string;
  source: string;
  repo_id: string | null;
  branch: string | null;
  pr_id: string | null;
  status: AgentStatus;
  cwd: string | null;
  raw_transcript_path: string | null;
  started_at: string | null;
  last_event_at: string | null;
}

export interface AppConfig {
  delete_head_on_merge: boolean;
  review_on_pr_open: boolean;
  agent_observe_enabled: boolean;
  chat_enabled: boolean;
  terminal_enabled: boolean;
  implement_enabled: boolean;
  sync_enabled: boolean;
  sync_interval_minutes: number;
}
