import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { listSessions } from "../store.js";
import { getConfig } from "../config.js";

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/agents", async () => {
    const cfg = getConfig(ctx.db);
    return {
      enabled: cfg.agent_observe_enabled && ctx.agents.isEnabled(),
      sources: ctx.agents.sourceCapabilities(),
      sessions: listSessions(ctx.db),
    };
  });

  app.post("/api/agents/refresh", async () => {
    const sessions = await ctx.agents.refresh();
    return { sessions };
  });

  // Hook notify endpoint: Claude Code hooks ping this for lower-latency updates.
  // The transcript on disk remains the source of truth; this just nudges a
  // refresh. Behind the same auth + Origin floor as every /api route.
  app.post("/api/agents/hook", async () => {
    void ctx.agents.refresh();
    return { ok: true };
  });
}
