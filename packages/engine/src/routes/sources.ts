import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { addSourceDir, listSourceDirs, removeSourceDir } from "../store.js";
import { scanAll } from "../scan.js";

export function registerSourceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/source-dirs", async () => listSourceDirs(ctx.db));

  app.post<{ Body: { path?: string } }>("/api/source-dirs", async (req, reply) => {
    const raw = req.body?.path?.trim();
    if (!raw) {
      reply.code(400);
      return { error: "path_required" };
    }
    const abs = path.resolve(raw);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      reply.code(400);
      return { error: "not_a_directory", path: abs };
    }
    const existing = listSourceDirs(ctx.db).find((d) => d.path === abs);
    const dir = existing ?? addSourceDir(ctx.db, abs);

    // Scan immediately so the user sees repos appear.
    const result = await scanAll(ctx.db);
    ctx.hub.broadcast("repos.updated", { repos: result.repos.length });
    return { dir, scanned: result.repos.length };
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
