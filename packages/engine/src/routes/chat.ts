import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { runChat, type ChatMessage } from "../chat.js";

// Models we let the UI pick. Mapped to `claude --model` aliases the CLI
// resolves. "" means: don't pass --model (use the user's configured default).
const ALLOWED_MODELS = new Set(["", "sonnet", "opus", "haiku"]);

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{
    Body: { message?: string; history?: ChatMessage[]; model?: string; repoId?: string };
  }>("/api/chat", async (req, reply) => {
    const message = req.body?.message?.trim();
    if (!message) {
      reply.code(400);
      return { error: "message_required" };
    }
    const history = Array.isArray(req.body?.history) ? req.body!.history! : [];
    const requested = req.body?.model ?? "";
    const model = ALLOWED_MODELS.has(requested) && requested ? requested : undefined;
    const repoId = req.body?.repoId?.trim() || undefined;
    const id = crypto.randomUUID();
    // Stream asynchronously over the WebSocket; respond immediately with the id.
    void runChat(ctx.db, ctx.hub, id, message, history, model, repoId);
    return { id };
  });
}
