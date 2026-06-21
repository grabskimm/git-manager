import type { DB } from "./db.js";
import type { WsHub } from "./ws.js";
import type { AgentManager } from "./agents/manager.js";
import type { SyncScheduler } from "./storage/scheduler.js";

export interface AppContext {
  db: DB;
  hub: WsHub;
  agents: AgentManager;
  sync: SyncScheduler;
  token: string;
  allowedOrigins: Set<string>;
  host: string;
  port: number;
}
