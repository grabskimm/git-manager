import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { getRepo, listRepos } from "../store.js";
import { diffRange, diffStat, listBranches, listTree, log, readFile } from "../git.js";

export function registerRepoRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/repos", async () => listRepos(ctx.db));

  app.get<{ Params: { id: string } }>("/api/repos/:id", async (req, reply) => {
    const repo = getRepo(ctx.db, req.params.id);
    if (!repo) {
      reply.code(404);
      return { error: "repo_not_found" };
    }
    return repo;
  });

  app.get<{ Params: { id: string } }>(
    "/api/repos/:id/branches",
    async (req, reply) => {
      const repo = getRepo(ctx.db, req.params.id);
      if (!repo) {
        reply.code(404);
        return { error: "repo_not_found" };
      }
      return listBranches(repo.abs_path);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { ref?: string; limit?: string } }>(
    "/api/repos/:id/commits",
    async (req, reply) => {
      const repo = getRepo(ctx.db, req.params.id);
      if (!repo) {
        reply.code(404);
        return { error: "repo_not_found" };
      }
      const ref = req.query.ref || repo.default_branch || "HEAD";
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      return log(repo.abs_path, ref, limit);
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { base?: string; head?: string };
  }>("/api/repos/:id/diff", async (req, reply) => {
    const repo = getRepo(ctx.db, req.params.id);
    if (!repo) {
      reply.code(404);
      return { error: "repo_not_found" };
    }
    const { base, head } = req.query;
    if (!base || !head) {
      reply.code(400);
      return { error: "base_and_head_required" };
    }
    const diff = await diffRange(repo.abs_path, base, head);
    const stat = await diffStat(repo.abs_path, base, head);
    return { base, head, diff, stat };
  });

  app.get<{
    Params: { id: string };
    Querystring: { ref?: string; path?: string };
  }>("/api/repos/:id/tree", async (req, reply) => {
    const repo = getRepo(ctx.db, req.params.id);
    if (!repo) {
      reply.code(404);
      return { error: "repo_not_found" };
    }
    const ref = req.query.ref || repo.default_branch || "HEAD";
    const entries = await listTree(repo.abs_path, ref, req.query.path ?? "");
    return { ref, path: req.query.path ?? "", entries };
  });

  app.get<{
    Params: { id: string };
    Querystring: { ref?: string; path?: string };
  }>("/api/repos/:id/file", async (req, reply) => {
    const repo = getRepo(ctx.db, req.params.id);
    if (!repo) {
      reply.code(404);
      return { error: "repo_not_found" };
    }
    const ref = req.query.ref || repo.default_branch || "HEAD";
    const path = req.query.path;
    if (!path) {
      reply.code(400);
      return { error: "path_required" };
    }
    const file = await readFile(repo.abs_path, ref, path);
    if (!file) {
      reply.code(404);
      return { error: "file_not_found" };
    }
    return file;
  });
}
