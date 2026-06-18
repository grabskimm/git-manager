import type { DB } from "./db.js";
import type { WsHub } from "./ws.js";
import type { AgentManager } from "./agents/manager.js";

export interface AppContext {
  db: DB;
  hub: WsHub;
  agents: AgentManager;
  token: string;
  allowedOrigins: Set<string>;
  host: string;
  port: number;
}
