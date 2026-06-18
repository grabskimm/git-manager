import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { addSourceDir, listSourceDirs, removeSourceDir } from "../store.js";
import { scanAll } from "../scan.js";
import { cloneRepo, isRemoteUrl, repoNameFromUrl } from "../git.js";
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
}
