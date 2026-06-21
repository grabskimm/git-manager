import type {
  AgentsResponse,
  AppConfig,
  Branch,
  Commit,
  DiffResponse,
  FileContent,
  Pr,
  PrDetail,
  Repo,
  SourceDir,
  TreeResponse,
} from "./types";

declare global {
  interface Window {
    __GM_TOKEN__?: string;
  }
}

/**
 * Resolve the loopback token. In production the engine injects
 * window.__GM_TOKEN__ into the served HTML. In dev, fall back to a Vite env var
 * or localStorage so the proxied dev server can authenticate.
 */
export function getToken(): string {
  if (typeof window !== "undefined" && window.__GM_TOKEN__) return window.__GM_TOKEN__;
  const env = import.meta.env.VITE_GM_TOKEN as string | undefined;
  if (env) return env;
  return localStorage.getItem("gm_token") ?? "";
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && "error" in body && String(body.error)) ||
      `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

export const api = {
  ping: () => request<{ ok: boolean; version: string }>("/api/ping"),

  // source dirs
  listSourceDirs: () => request<SourceDir[]>("/api/source-dirs"),
  addSourceDir: (path: string) =>
    request<{ dir: SourceDir; scanned: number; cloned?: string }>("/api/source-dirs", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  removeSourceDir: (id: string) =>
    request<{ ok: boolean }>(`/api/source-dirs/${id}`, { method: "DELETE" }),
  scan: () => request<{ scanned: number; repos: Repo[] }>("/api/scan", { method: "POST" }),
  createRepo: (parent: string, name: string) =>
    request<{ repo: Repo | null; path: string }>("/api/repos/new", {
      method: "POST",
      body: JSON.stringify({ parent, name }),
    }),

  // repos
  listRepos: () => request<Repo[]>("/api/repos"),
  getRepo: (id: string) => request<Repo>(`/api/repos/${id}`),
  branches: (id: string) => request<Branch[]>(`/api/repos/${id}/branches`),
  commits: (id: string, ref?: string) =>
    request<Commit[]>(`/api/repos/${id}/commits${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`),
  diff: (id: string, base: string, head: string) =>
    request<DiffResponse>(
      `/api/repos/${id}/diff?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`,
    ),
  tree: (id: string, ref: string, path = "") =>
    request<TreeResponse>(
      `/api/repos/${id}/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
    ),
  file: (id: string, ref: string, path: string) =>
    request<FileContent>(
      `/api/repos/${id}/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
    ),

  // prs
  listPrs: (repoId?: string) =>
    request<Pr[]>(`/api/prs${repoId ? `?repoId=${encodeURIComponent(repoId)}` : ""}`),
  getPr: (id: string) => request<PrDetail>(`/api/prs/${id}`),
  createPr: (input: {
    repo_id: string;
    title: string;
    description?: string;
    base_ref: string;
    head_ref: string;
    remote?: boolean;
  }) => request<Pr>("/api/prs", { method: "POST", body: JSON.stringify(input) }),
  mergePr: (id: string) => request<Pr>(`/api/prs/${id}/merge`, { method: "POST" }),
  closePr: (id: string) => request<Pr>(`/api/prs/${id}/close`, { method: "POST" }),
  refreshPr: (id: string) => request<Pr>(`/api/prs/${id}/refresh`, { method: "POST" }),
  rereview: (id: string) =>
    request<{ ok: boolean }>(`/api/prs/${id}/review`, { method: "POST" }),
  replyToReview: (id: string, message: string) =>
    request<{ ok: boolean; started: boolean }>(`/api/prs/${id}/reply`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  implementReview: (id: string, message: string) =>
    request<{ ok: boolean; started: boolean }>(`/api/prs/${id}/implement`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  mergeability: (id: string) =>
    request<{ mergeable: "clean" | "conflict" | "error" }>(`/api/prs/${id}/mergeability`),
  comment: (id: string, body: string, anchor?: { file_path?: string; line?: number }) =>
    request<unknown>(`/api/prs/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, ...anchor }),
    }),

  // config
  getConfig: () => request<AppConfig>("/api/config"),
  setConfig: (patch: Partial<AppConfig>) =>
    request<AppConfig>("/api/config", { method: "PUT", body: JSON.stringify(patch) }),

  // chat
  chat: (
    message: string,
    history: { role: "user" | "assistant"; content: string }[],
    model?: string,
    repoId?: string,
  ) =>
    request<{ id: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message, history, model, repoId }),
    }),

  // agents
  agents: () => request<AgentsResponse>("/api/agents"),
  refreshAgents: () => request<{ sessions: unknown }>("/api/agents/refresh", { method: "POST" }),

  // sync / backup
  syncStatus: () => request<SyncStatus>("/api/sync/status"),
  getSyncConfig: () => request<{ backends: unknown[] }>("/api/sync/config"),
  setSyncConfig: (cfg: { backends: unknown[] }) =>
    request<{ backends: unknown[] }>("/api/sync/config", {
      method: "PUT",
      body: JSON.stringify(cfg),
    }),
  syncPush: (repoId?: string) =>
    request<{ pushed: SyncPushRepo[] }>("/api/sync/push", {
      method: "POST",
      body: JSON.stringify({ repoId }),
    }),
  syncPull: (gmId: string, into?: string) =>
    request<{ status: string; reason?: string; path?: string; refs?: string[] }>("/api/sync/pull", {
      method: "POST",
      body: JSON.stringify({ gmId, into }),
    }),
};

export interface SyncStatus {
  sync_enabled: boolean;
  sync_interval_minutes: number;
  backends: { id: string; label: string; enabled: boolean; ready: { ok: boolean; reason?: string } }[];
  manifest: { updatedAt: string; repos: Record<string, { name: string; lastBackupAt: string; bytes: number }> } | null;
  manifestFrom: string | null;
}
export interface SyncPushRepo {
  repo: string;
  gmId: string;
  results: { backend: string; status: string; reason?: string; bytes?: number }[];
}
