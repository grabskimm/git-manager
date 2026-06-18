import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import {
  addThreadEntry,
  createPr,
  getPr,
  getRepo,
  listPrs,
  listThread,
  updatePr,
} from "../store.js";
import { branchExists, revParse } from "../git.js";
import { attemptMerge, dryRunMerge } from "../merge.js";
import { getConfig } from "../config.js";
import { runReview, runReviewReply } from "../review.js";
import { runImplement } from "../implement.js";

export function registerPrRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { repoId?: string } }>("/api/prs", async (req) =>
    listPrs(ctx.db, req.query.repoId),
  );

  app.get<{ Params: { id: string } }>("/api/prs/:id", async (req, reply) => {
    const pr = getPr(ctx.db, req.params.id);
    if (!pr) {
      reply.code(404);
      return { error: "pr_not_found" };
    }
    return { pr, thread: listThread(ctx.db, pr.id), repo: getRepo(ctx.db, pr.repo_id) };
  });

  app.post<{
    Body: {
      repo_id?: string;
      title?: string;
      description?: string;
      base_ref?: string;
      head_ref?: string;
    };
  }>("/api/prs", async (req, reply) => {
    const { repo_id, title, base_ref, head_ref } = req.body ?? {};
    if (!repo_id || !title || !base_ref || !head_ref) {
      reply.code(400);
      return { error: "missing_fields", required: ["repo_id", "title", "base_ref", "head_ref"] };
    }
    const repo = getRepo(ctx.db, repo_id);
    if (!repo) {
      reply.code(404);
      return { error: "repo_not_found" };
    }
    if (base_ref === head_ref) {
      reply.code(400);
      return { error: "base_equals_head" };
    }
    if (!(await branchExists(repo.abs_path, base_ref))) {
      reply.code(400);
      return { error: "base_ref_not_found", ref: base_ref };
    }
    if (!(await revParse(repo.abs_path, head_ref))) {
      reply.code(400);
      return { error: "head_ref_not_found", ref: head_ref };
    }

    const pr = createPr(ctx.db, {
      repo_id,
      title,
      description: req.body?.description ?? null,
      base_ref,
      head_ref,
    });
    addThreadEntry(ctx.db, {
      pr_id: pr.id,
      author: "system",
      kind: "status_change",
      body: `Opened PR: \`${head_ref}\` → \`${base_ref}\`.`,
    });
    ctx.hub.broadcast("pr.created", { pr });

    // Trigger the Claude review asynchronously (§10). Never blocks PR creation.
    if (getConfig(ctx.db).review_on_pr_open) {
      void runReview(ctx.db, ctx.hub, repo, pr).then(() => {
        ctx.hub.broadcast("pr.updated", { prId: pr.id });
      });
    }

    return pr;
  });

  app.get<{ Params: { id: string } }>(
    "/api/prs/:id/mergeability",
    async (req, reply) => {
      const pr = getPr(ctx.db, req.params.id);
      if (!pr) {
        reply.code(404);
        return { error: "pr_not_found" };
      }
      const repo = getRepo(ctx.db, pr.repo_id);
      if (!repo) {
        reply.code(404);
        return { error: "repo_not_found" };
      }
      const result = await dryRunMerge(repo.abs_path, pr.base_ref, pr.head_ref);
      return { mergeable: result };
    },
  );

  app.post<{ Params: { id: string } }>("/api/prs/:id/merge", async (req, reply) => {
    const pr = getPr(ctx.db, req.params.id);
    if (!pr) {
      reply.code(404);
      return { error: "pr_not_found" };
    }
    if (pr.status !== "open" && pr.status !== "conflicted") {
      reply.code(409);
      return { error: "pr_not_mergeable", status: pr.status };
    }
    const repo = getRepo(ctx.db, pr.repo_id);
    if (!repo) {
      reply.code(404);
      return { error: "repo_not_found" };
    }

    const cfg = getConfig(ctx.db);
    const outcome = await attemptMerge(repo.abs_path, pr.base_ref, pr.head_ref, {
      deleteHeadOnMerge: cfg.delete_head_on_merge,
    });

    if (outcome.status === "merged") {
      const updated = updatePr(ctx.db, pr.id, {
        status: "merged",
        merge_commit_sha: outcome.mergeCommitSha,
        merged_at: new Date().toISOString(),
      });
      addThreadEntry(ctx.db, {
        pr_id: pr.id,
        author: "system",
        kind: "status_change",
        body: `Merged ${outcome.fastForward ? "(fast-forward)" : "(merge commit)"} as \`${outcome.mergeCommitSha}\`.${
          cfg.delete_head_on_merge ? ` Head branch \`${pr.head_ref}\` deleted.` : ""
        }`,
      });
      ctx.hub.broadcast("pr.updated", { prId: pr.id });
      return updated;
    }

    if (outcome.status === "conflicted") {
      const updated = updatePr(ctx.db, pr.id, { status: "conflicted" });
      addThreadEntry(ctx.db, {
        pr_id: pr.id,
        author: "system",
        kind: "status_change",
        body: `Merge conflict — resolve locally on \`${pr.head_ref}\`, then refresh. Conflicted files:\n${outcome.conflictedFiles
          .map((f) => `- \`${f}\``)
          .join("\n")}`,
      });
      ctx.hub.broadcast("pr.updated", { prId: pr.id });
      reply.code(409);
      return updated;
    }

    reply.code(400);
    return { error: "merge_failed", message: outcome.message };
  });

  app.post<{ Params: { id: string } }>("/api/prs/:id/refresh", async (req, reply) => {
    const pr = getPr(ctx.db, req.params.id);
    if (!pr) {
      reply.code(404);
      return { error: "pr_not_found" };
    }
    if (pr.status !== "conflicted") return pr;
    const repo = getRepo(ctx.db, pr.repo_id);
    if (!repo) {
      reply.code(404);
      return { error: "repo_not_found" };
    }
    const result = await dryRunMerge(repo.abs_path, pr.base_ref, pr.head_ref);
    if (result === "clean") {
      const updated = updatePr(ctx.db, pr.id, { status: "open" });
      addThreadEntry(ctx.db, {
        pr_id: pr.id,
        author: "system",
        kind: "status_change",
        body: "Conflict resolved — PR re-opened and is mergeable again.",
      });
      ctx.hub.broadcast("pr.updated", { prId: pr.id });
      return updated;
    }
    return pr;
  });

  app.post<{ Params: { id: string } }>("/api/prs/:id/close", async (req, reply) => {
    const pr = getPr(ctx.db, req.params.id);
    if (!pr) {
      reply.code(404);
      return { error: "pr_not_found" };
    }
    if (pr.status === "merged") {
      reply.code(409);
      return { error: "cannot_close_merged" };
    }
    const updated = updatePr(ctx.db, pr.id, { status: "closed" });
    addThreadEntry(ctx.db, {
      pr_id: pr.id,
      author: "system",
      kind: "status_change",
      body: "PR closed.",
    });
    ctx.hub.broadcast("pr.updated", { prId: pr.id });
    return updated;
  });

  app.post<{
    Params: { id: string };
    Body: { body?: string; file_path?: string; line?: number };
  }>("/api/prs/:id/comments", async (req, reply) => {
    const pr = getPr(ctx.db, req.params.id);
    if (!pr) {
      reply.code(404);
      return { error: "pr_not_found" };
    }
    const body = req.body?.body?.trim();
    if (!body) {
      reply.code(400);
      return { error: "body_required" };
    }
    const filePath = req.body?.file_path?.trim() || null;
    const rawLine = req.body?.line;
    const line =
      typeof rawLine === "number" && Number.isFinite(rawLine) && rawLine > 0
        ? Math.floor(rawLine)
        : null;
    const entry = addThreadEntry(ctx.db, {
      pr_id: pr.id,
      author: "user",
      kind: "comment",
      body,
      file_path: filePath,
      line,
    });
    ctx.hub.broadcast("pr.updated", { prId: pr.id });
    return entry;
  });

  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    "/api/prs/:id/reply",
    async (req, reply) => {
      const pr = getPr(ctx.db, req.params.id);
      if (!pr) {
        reply.code(404);
        return { error: "pr_not_found" };
      }
      const repo = getRepo(ctx.db, pr.repo_id);
      if (!repo) {
        reply.code(404);
        return { error: "repo_not_found" };
      }
      const message = req.body?.message?.trim();
      if (!message) {
        reply.code(400);
        return { error: "message_required" };
      }
      // Persist the author's reply first so it shows immediately, then run
      // Claude's response asynchronously (streams over review.* events).
      addThreadEntry(ctx.db, { pr_id: pr.id, author: "user", kind: "comment", body: message });
      ctx.hub.broadcast("pr.updated", { prId: pr.id });
      void runReviewReply(ctx.db, ctx.hub, repo, pr).then(() => {
        ctx.hub.broadcast("pr.updated", { prId: pr.id });
      });
      return { ok: true, started: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    "/api/prs/:id/implement",
    async (req, reply) => {
      if (!getConfig(ctx.db).implement_enabled) {
        reply.code(403);
        return { error: "implement_disabled" };
      }
      const pr = getPr(ctx.db, req.params.id);
      if (!pr) {
        reply.code(404);
        return { error: "pr_not_found" };
      }
      if (pr.status === "merged" || pr.status === "closed") {
        reply.code(409);
        return { error: "pr_not_open", status: pr.status };
      }
      const repo = getRepo(ctx.db, pr.repo_id);
      if (!repo) {
        reply.code(404);
        return { error: "repo_not_found" };
      }
      const message = req.body?.message?.trim();
      if (!message) {
        reply.code(400);
        return { error: "message_required" };
      }
      addThreadEntry(ctx.db, { pr_id: pr.id, author: "user", kind: "comment", body: message });
      ctx.hub.broadcast("pr.updated", { prId: pr.id });
      void runImplement(ctx.db, ctx.hub, repo, pr).then(() => {
        ctx.hub.broadcast("pr.updated", { prId: pr.id });
      });
      return { ok: true, started: true };
    },
  );

  app.post<{ Params: { id: string } }>("/api/prs/:id/review", async (req, reply) => {
    const pr = getPr(ctx.db, req.params.id);
    if (!pr) {
      reply.code(404);
      return { error: "pr_not_found" };
    }
    const repo = getRepo(ctx.db, pr.repo_id);
    if (!repo) {
      reply.code(404);
      return { error: "repo_not_found" };
    }
    void runReview(ctx.db, ctx.hub, repo, pr).then(() => {
      ctx.hub.broadcast("pr.updated", { prId: pr.id });
    });
    return { ok: true, started: true };
  });
}
