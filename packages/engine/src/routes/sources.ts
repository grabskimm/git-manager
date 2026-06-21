import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { addSourceDir, listRepos, listSourceDirs, removeSourceDir } from "../store.js";
import { scanAll } from "../scan.js";
import { cloneRepo, createLocalRepo, isRemoteUrl, repoNameFromUrl } from "../git.js";
import { gitmanagerHome } from "../paths.js";

/** Expand a leading ~ and resolve to an absolute, OS-native path. */
function normalizeLocalPath(input: string): string {
  let p = input.trim();
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(os.homedir(), p.slice(2));
  }
  return path.resolve(p);
}

/** Pick a non-colliding clone target under the managed clones directory. */
function uniqueCloneTarget(name: string): string {
  const dir = path.join(gitmanagerHome(), "clones");
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, name);
  let n = 2;
  while (fs.existsSync(target)) target = path.join(dir, `${name}-${n++}`);
  return target;
}

export function registerSourceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/source-dirs", async () => listSourceDirs(ctx.db));

  app.post<{ Body: { path?: string } }>("/api/source-dirs", async (req, reply) => {
    const raw = req.body?.path?.trim();
    if (!raw) {
      reply.code(400);
      return { error: "path_required" };
    }

    let abs: string;
    let cloned: string | undefined;

    if (isRemoteUrl(raw)) {
      // Clone the remote into a managed local directory; the local .git is then
      // canonical, consistent with the local-first model.
      const target = uniqueCloneTarget(repoNameFromUrl(raw));
      const res = await cloneRepo(raw, target);
      if (res.code !== 0) {
        reply.code(400);
        return { error: "clone_failed", message: res.stderr.trim() || "git clone failed" };
      }
      cloned = target;
      // Register the managed clones directory as the source dir so this and
      // future clones are scanned.
      abs = path.dirname(target);
    } else {
      abs = normalizeLocalPath(raw);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        reply.code(400);
        return { error: "not_a_directory", path: abs };
      }
    }

    const existing = listSourceDirs(ctx.db).find((d) => d.path === abs);
    const dir = existing ?? addSourceDir(ctx.db, abs);

    // Scan immediately so the user sees repos appear.
    const result = await scanAll(ctx.db);
    ctx.hub.broadcast("repos.updated", { repos: result.repos.length });
    return { dir, scanned: result.repos.length, cloned };
  });

  app.delete<{ Params: { id: string } }>(
    "/api/source-dirs/:id",
    async (req) => {
      removeSourceDir(ctx.db, req.params.id);
      return { ok: true };
    },
  );

  app.post("/api/scan", async () => {
    const result = await scanAll(ctx.db);
    ctx.hub.broadcast("repos.updated", { repos: result.repos.length });
    return { scanned: result.scanned, repos: result.repos };
  });

  // Create a brand-new local repo under a parent directory, register that
  // parent as a source dir, scan, and return the new repo.
  app.post<{ Body: { parent?: string; name?: string } }>(
    "/api/repos/new",
    async (req, reply) => {
      const name = req.body?.name?.trim();
      const parentRaw = req.body?.parent?.trim();
      if (!name || !parentRaw) {
        reply.code(400);
        return { error: "name_and_parent_required" };
      }
      if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") {
        reply.code(400);
        return { error: "invalid_name", message: "Use letters, numbers, dot, dash, underscore." };
      }

      const parent = normalizeLocalPath(parentRaw);
      if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
        reply.code(400);
        return { error: "parent_not_a_directory", path: parent };
      }
      const dir = path.join(parent, name);
      if (fs.existsSync(dir)) {
        reply.code(409);
        return { error: "already_exists", path: dir };
      }

      fs.mkdirSync(dir, { recursive: true });
      try {
        await createLocalRepo(dir, name);
      } catch (e) {
        reply.code(400);
        return { error: "init_failed", message: (e as Error).message };
      }

      if (!listSourceDirs(ctx.db).some((d) => d.path === parent)) {
        addSourceDir(ctx.db, parent);
      }
      await scanAll(ctx.db);
      ctx.hub.broadcast("repos.updated", { repos: listRepos(ctx.db).length });
      const repo = listRepos(ctx.db).find((r) => r.abs_path === dir) ?? null;
      return { repo, path: dir };
    },
  );
}
