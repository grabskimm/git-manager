import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { getConfig, updateConfig } from "../config.js";

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/config", async () => getConfig(ctx.db));

  app.put<{ Body: Record<string, unknown> }>("/api/config", async (req) => {
    const next = updateConfig(ctx.db, req.body ?? {});
    // Apply side effects (e.g. enable/disable agent observation).
    ctx.agents.syncWithConfig();
    return next;
  });
}
