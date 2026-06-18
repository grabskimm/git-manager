import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { runChat, type ChatMessage } from "../chat.js";

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: { message?: string; history?: ChatMessage[] } }>(
    "/api/chat",
    async (req, reply) => {
      const message = req.body?.message?.trim();
      if (!message) {
        reply.code(400);
        return { error: "message_required" };
      }
      const history = Array.isArray(req.body?.history) ? req.body!.history! : [];
      const id = crypto.randomUUID();
      // Stream asynchronously over the WebSocket; respond immediately with the id.
      void runChat(ctx.db, ctx.hub, id, message, history);
      return { id };
    },
  );
}
