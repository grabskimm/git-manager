import path from "node:path";
import { layout, prefixOf } from "./backend.js";
import type {
  BackendConfig,
  Manifest,
  RepoIndex,
  SnapshotRef,
  StorageBackend,
} from "./backend.js";
import { backendFromConfig } from "./index.js";
import { createBundle, cloneFromBundle, fetchFromBundle, headSha } from "./bundle.js";
import { log, debug } from "../logger.js";

const MAX_SNAPSHOTS = 10;

async function readJson<T>(backend: StorageBackend, key: string): Promise<T | null> {
  const buf = await backend.get(key);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(backend: StorageBackend, key: string, value: unknown): Promise<void> {
  await backend.put(key, Buffer.from(JSON.stringify(value, null, 2)));
}

export interface RepoLike {
  id: string;
  display_name: string;
  abs_path: string;
  default_branch: string | null;
}

export interface PushResult {
  backend: string;
  status: "ok" | "skipped";
  reason?: string;
  bytes?: number;
  snapshotKey?: string;
}

/** Back up one repo to a single backend: bundle → snapshot → index → manifest. */
async function pushRepoToBackend(
  cfg: BackendConfig,
  repo: RepoLike,
  bundle: Buffer,
  sha: string | null,
): Promise<PushResult> {
  const backend = backendFromConfig(cfg);
  debug(`sync: ${repo.display_name} → ${backend.label}: checking readiness`);
  const ready = await backend.isReady();
  if (!ready.ok) {
    log(`sync: ${repo.display_name} → ${backend.label}: skipped (${ready.reason})`);
    return { backend: backend.label, status: "skipped", reason: ready.reason };
  }

  const prefix = prefixOf(cfg);
  const ts = new Date().toISOString();
  const snapKey = layout.snapshot(prefix, repo.id, ts);

  log(`sync: ${repo.display_name} → ${backend.label}: uploading snapshot (${bundle.length} bytes) ${snapKey}`);
  await backend.put(snapKey, bundle);
  debug(`sync: ${repo.display_name} → ${backend.label}: snapshot uploaded, updating index`);

  // Update the per-repo index (snapshot history + latest), prune old snapshots.
  const idx: RepoIndex =
    (await readJson<RepoIndex>(backend, layout.repoIndex(prefix, repo.id))) ?? {
      gmId: repo.id,
      name: repo.display_name,
      defaultBranch: repo.default_branch,
      latest: null,
      snapshots: [],
    };
  idx.name = repo.display_name;
  idx.defaultBranch = repo.default_branch;
  idx.latest = snapKey;
  idx.snapshots.unshift({ key: snapKey, timestamp: ts, headSha: sha } as SnapshotRef);
  const prune = idx.snapshots.slice(MAX_SNAPSHOTS);
  idx.snapshots = idx.snapshots.slice(0, MAX_SNAPSHOTS);
  await writeJson(backend, layout.repoIndex(prefix, repo.id), idx);
  for (const old of prune) await backend.del(old.key).catch(() => {});

  // Update the top-level manifest.
  const manifest: Manifest =
    (await readJson<Manifest>(backend, layout.manifest(prefix))) ?? { updatedAt: ts, repos: {} };
  manifest.repos[repo.id] = {
    name: repo.display_name,
    defaultBranch: repo.default_branch,
    lastBackupAt: ts,
    bytes: bundle.length,
  };
  manifest.updatedAt = ts;
  await writeJson(backend, layout.manifest(prefix), manifest);

  log(`sync: ${repo.display_name} → ${backend.label}: done (${bundle.length} bytes)`);
  return { backend: backend.label, status: "ok", bytes: bundle.length, snapshotKey: snapKey };
}

/** Back up one repo to every enabled backend. Never throws. */
export async function pushRepo(backends: BackendConfig[], repo: RepoLike): Promise<PushResult[]> {
  if (backends.length === 0) {
    return [{ backend: "(none)", status: "skipped", reason: "No storage backend is configured." }];
  }
  let bundle: Buffer;
  let sha: string | null;
  try {
    debug(`sync: ${repo.display_name}: bundling ${repo.abs_path}`);
    bundle = await createBundle(repo.abs_path);
    sha = await headSha(repo.abs_path);
    debug(`sync: ${repo.display_name}: bundled ${bundle.length} bytes`);
  } catch (e) {
    // e.g. an empty repo (no commits) — skip it without failing the batch.
    const reason = `could not bundle ${repo.display_name}: ${(e as Error).message}`;
    return backends.map((cfg) => ({ backend: cfg.id, status: "skipped" as const, reason }));
  }
  const out: PushResult[] = [];
  for (const cfg of backends) {
    try {
      out.push(await pushRepoToBackend(cfg, repo, bundle, sha));
    } catch (e) {
      // A backend op threw (e.g. an Azure 403 on blob write). Surface it loudly
      // instead of silently recording a "skipped" — a swallowed error here is
      // exactly what makes a backup look like it "succeeded" into an empty bucket.
      const err = e as { code?: string; statusCode?: number; message?: string };
      const reason = [err.code, err.statusCode, err.message].filter(Boolean).join(" ") || String(e);
      log(`sync: ${repo.display_name} → ${cfg.id}: FAILED — ${reason}`);
      out.push({ backend: cfg.id, status: "skipped", reason });
    }
  }
  return out;
}

/** Read the manifest from the first enabled backend that has one. */
export async function readManifest(
  backends: BackendConfig[],
): Promise<{ backend: string; manifest: Manifest } | null> {
  for (const cfg of backends) {
    const backend = backendFromConfig(cfg);
    const manifest = await readJson<Manifest>(backend, layout.manifest(prefixOf(cfg)));
    if (manifest) return { backend: backend.label, manifest };
  }
  return null;
}

export interface Readiness {
  id: string;
  label: string;
  enabled: boolean;
  ready: { ok: true } | { ok: false; reason: string };
}

/**
 * Readiness of one backend. Reachable isn't the same as writable — a read-only
 * check (HeadBucket / createIfNotExists) passes even when the identity can't
 * write, silently producing empty backups. When `probeWrite` is set we confirm
 * a real write/delete round-trip under the configured prefix, reusing the
 * backend instance so it shares any timeout/error handling.
 */
export async function backendReadiness(cfg: BackendConfig, probeWrite = true): Promise<Readiness> {
  const backend = backendFromConfig(cfg);
  let ready = await backend.isReady();
  if (ready.ok && probeWrite) {
    const probe = layout.writeProbe(prefixOf(cfg));
    try {
      await backend.put(probe, Buffer.from("gitm-write-probe"));
      await backend.del(probe).catch(() => {});
    } catch (e) {
      ready = { ok: false, reason: `reachable but write failed: ${(e as Error).message}` };
    }
  }
  return { id: cfg.id, label: backend.label, enabled: cfg.enabled, ready };
}

export interface PullResult {
  status: "cloned" | "updated" | "skipped";
  reason?: string;
  refs?: string[];
  path?: string;
}

/**
 * Restore a repo from storage. If `existingPath` is given (repo already present
 * locally), fetch non-destructively into refs/remotes/gm-backup/*. Otherwise
 * clone into `<intoDir>/<name>` from the latest snapshot.
 */
export async function pullRepo(
  backends: BackendConfig[],
  gmId: string,
  opts: { existingPath?: string; intoDir?: string },
): Promise<PullResult> {
  for (const cfg of backends) {
    const backend = backendFromConfig(cfg);
    const prefix = prefixOf(cfg);
    const idx = await readJson<RepoIndex>(backend, layout.repoIndex(prefix, gmId));
    if (!idx?.latest) continue;
    const bundle = await backend.get(idx.latest);
    if (!bundle) continue;

    if (opts.existingPath) {
      const refs = await fetchFromBundle(opts.existingPath, bundle);
      return { status: "updated", refs, path: opts.existingPath };
    }
    const target = path.join(opts.intoDir ?? process.cwd(), idx.name || gmId);
    await cloneFromBundle(bundle, target);
    return { status: "cloned", path: target };
  }
  return { status: "skipped", reason: `No backup found for ${gmId} in any configured backend.` };
}
