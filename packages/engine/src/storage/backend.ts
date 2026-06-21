// A storage backend is a minimal object store: put/get/delete by key. Listing
// is intentionally NOT required — snapshot history is tracked in a per-repo
// index.json and repo discovery in a top-level manifest.json, so every backend
// (incl. ones whose CLI can't list, like wrangler) works the same way.

export interface StorageBackend {
  readonly id: string;
  readonly label: string;
  /** True when the backend's credentials/tooling are usable right now. */
  isReady(): Promise<{ ok: true } | { ok: false; reason: string }>;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  del(key: string): Promise<void>;
}

export type BackendConfig =
  | { id: "fs"; enabled: boolean; dir: string; prefix?: string }
  | { id: "s3"; enabled: boolean; bucket: string; region?: string; endpoint?: string; prefix?: string }
  | { id: "r2"; enabled: boolean; bucket: string; prefix?: string }
  | { id: "azure"; enabled: boolean; account: string; container: string; prefix?: string };

export interface StorageConfig {
  backends: BackendConfig[];
}

/** One stored snapshot of a repo. */
export interface SnapshotRef {
  key: string; // object key of the .bundle
  timestamp: string; // ISO
  headSha: string | null;
}

/** Per-repo index of snapshots (no bucket listing needed). */
export interface RepoIndex {
  gmId: string;
  name: string;
  defaultBranch: string | null;
  latest: string | null; // key of the newest snapshot
  snapshots: SnapshotRef[];
}

/** Top-level manifest so a fresh device can discover what to restore. */
export interface Manifest {
  updatedAt: string;
  repos: Record<
    string,
    { name: string; defaultBranch: string | null; lastBackupAt: string; bytes: number }
  >;
}

const DEFAULT_PREFIX = "gitmanager";

export function prefixOf(cfg: BackendConfig): string {
  return (cfg.prefix && cfg.prefix.replace(/\/+$/, "")) || DEFAULT_PREFIX;
}

export const layout = {
  manifest: (prefix: string) => `${prefix}/manifest.json`,
  repoIndex: (prefix: string, gmId: string) => `${prefix}/repos/${gmId}/index.json`,
  snapshot: (prefix: string, gmId: string, ts: string) =>
    `${prefix}/repos/${gmId}/snapshots/${ts.replace(/[:.]/g, "-")}.bundle`,
};
