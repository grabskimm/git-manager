import path from "node:path";
import os from "node:os";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { getConfig } from "../config.js";
import { addSourceDir, getRepo, listRepos, listSourceDirs } from "../store.js";
import { scanAll } from "../scan.js";
import { loadStorageConfig, saveStorageConfig, enabledBackends } from "../storage/config.js";
import { backendFromConfig, layout, prefixOf } from "../storage/index.js";
import { pushRepo, pullRepo, readManifest, type RepoLike } from "../storage/sync.js";
import type { StorageConfig } from "../storage/backend.js";

function expandHome(p: string): string {
  const t = p.trim();
  if (t === "~") return os.homedir();
  if (t.startsWith("~/") || t.startsWith("~\\")) return path.join(os.homedir(), t.slice(2));
  return path.resolve(t);
}

export function registerSyncRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Current storage config (no secrets — creds come from provider auth).
  app.get("/api/sync/config", async () => loadStorageConfig());

  app.put<{ Body: StorageConfig }>("/api/sync/config", async (req, reply) => {
    const backends = Array.isArray(req.body?.backends) ? req.body.backends : null;
    if (!backends) {
      reply.code(400);
      return { error: "backends_array_required" };
    }
    saveStorageConfig({ backends });
    return loadStorageConfig();
  });

  // Readiness of each configured backend + the remote manifest + schedule.
  app.get("/api/sync/status", async () => {
    const cfg = loadStorageConfig();
    const appCfg = getConfig(ctx.db);
    const backends = await Promise.all(
      cfg.backends.map(async (b) => {
        const backend = backendFromConfig(b);
        let ready = await backend.isReady();
        // Reachable isn't the same as writable — verify a real write so the
        // "ready" badge can't go green while backups silently fail (e.g. an
        // Azure identity that can read the container but lacks write access).
        if (ready.ok && b.enabled) {
          const probe = layout.writeProbe(prefixOf(b));
          try {
            await backend.put(probe, Buffer.from("gitm-write-probe"));
            await backend.del(probe).catch(() => {});
          } catch (e) {
            ready = { ok: false, reason: `reachable but write failed: ${(e as Error).message}` };
          }
        }
        return { id: b.id, label: backend.label, enabled: b.enabled, ready };
      }),
    );
    const manifest = await readManifest(enabledBackends(cfg)).catch(() => null);
    return {
      sync_enabled: appCfg.sync_enabled,
      sync_interval_minutes: appCfg.sync_interval_minutes,
      backends,
      manifest: manifest?.manifest ?? null,
      manifestFrom: manifest?.backend ?? null,
    };
  });

  // Push one repo (by id) or all tracked repos to every enabled backend.
  app.post<{ Body: { repoId?: string } }>("/api/sync/push", async (req, reply) => {
    const backends = enabledBackends(loadStorageConfig());
    const repos: RepoLike[] = req.body?.repoId
      ? ([getRepo(ctx.db, req.body.repoId)].filter(Boolean) as RepoLike[])
      : (listRepos(ctx.db) as RepoLike[]);
    if (repos.length === 0) {
      reply.code(404);
      return { error: "no_repo" };
    }
    const results = [];
    for (const repo of repos) {
      try {
        results.push({ repo: repo.display_name, gmId: repo.id, results: await pushRepo(backends, repo) });
      } catch (e) {
        results.push({
          repo: repo.display_name,
          gmId: repo.id,
          results: [{ backend: "(error)", status: "skipped", reason: (e as Error).message }],
        });
      }
    }
    return { pushed: results };
  });

  // Restore a repo. If it's already tracked locally → non-destructive fetch.
  // Otherwise clone into `into` (a directory) from the latest snapshot, then
  // auto-register that directory as a source so the repo appears immediately.
  app.post<{ Body: { gmId?: string; into?: string } }>("/api/sync/pull", async (req, reply) => {
    const gmId = req.body?.gmId;
    if (!gmId) {
      reply.code(400);
      return { error: "gmId_required" };
    }
    const backends = enabledBackends(loadStorageConfig());
    const existing = getRepo(ctx.db, gmId);
    const intoDir = req.body?.into ? expandHome(req.body.into) : undefined;
    const result = await pullRepo(backends, gmId, {
      existingPath: existing?.abs_path,
      intoDir,
    });
    if (result.status === "cloned" && result.path) {
      const parentDir = path.dirname(result.path);
      const alreadySource = listSourceDirs(ctx.db).some((d) => d.path === parentDir);
      if (!alreadySource) addSourceDir(ctx.db, parentDir);
      await scanAll(ctx.db);
      ctx.hub.broadcast("repos.updated", { repos: listRepos(ctx.db).length });
    }
    return result;
  });
}
