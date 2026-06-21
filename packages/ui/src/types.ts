// Mirror of the engine's domain types (the frontend↔engine contract).

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

export interface PrThreadEntry {
  id: string;
  pr_id: string;
  author: "claude" | "user" | "system";
  kind: "review" | "comment" | "status_change";
  body: string;
  file_path: string | null;
  line: number | null;
  created_at: string;
}

export interface Branch {
  name: string;
  sha: string;
  isHead: boolean;
}

export interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export type AgentStatus = "running" | "waiting" | "idle" | "done";

export interface AgentSession {
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

export interface AgentCapabilities {
  observe: boolean;
  control: boolean;
}

export interface AgentsResponse {
  enabled: boolean;
  sources: { id: string; displayName?: string; capabilities: AgentCapabilities }[];
  sessions: AgentSession[];
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

export interface DiffResponse {
  base: string;
  head: string;
  diff: string;
  stat: string;
}

export interface PrDetail {
  pr: Pr;
  thread: PrThreadEntry[];
  repo: Repo | undefined;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "tree" | "blob";
  size: number | null;
}

export interface TreeResponse {
  ref: string;
  path: string;
  entries: TreeEntry[];
}

export interface FileContent {
  path: string;
  ref: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string;
}
