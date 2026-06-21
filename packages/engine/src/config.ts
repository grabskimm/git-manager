import type { DB } from "./db.js";
import type { AppConfig } from "./types.js";

export function getConfig(db: DB): AppConfig {
  const rows = db.prepare("SELECT key, value FROM config").all() as {
    key: string;
    value: string;
  }[];
  const map = new Map(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
  return {
    delete_head_on_merge: Boolean(map.get("delete_head_on_merge") ?? true),
    review_on_pr_open: Boolean(map.get("review_on_pr_open") ?? true),
    agent_observe_enabled: Boolean(map.get("agent_observe_enabled") ?? false),
    chat_enabled: Boolean(map.get("chat_enabled") ?? false),
    terminal_enabled: Boolean(map.get("terminal_enabled") ?? false),
    implement_enabled: Boolean(map.get("implement_enabled") ?? false),
    sync_enabled: Boolean(map.get("sync_enabled") ?? false),
    sync_interval_minutes: clampInterval(Number(map.get("sync_interval_minutes") ?? 10)),
  };
}

function clampInterval(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.min(Math.max(Math.floor(n), 1), 1440);
}

// Keys whose value is numeric (not coerced to boolean on write).
const NUMERIC_KEYS = new Set(["sync_interval_minutes"]);

export function setConfigValue(db: DB, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
}

const ALLOWED_KEYS = new Set([
  "delete_head_on_merge",
  "review_on_pr_open",
  "agent_observe_enabled",
  "chat_enabled",
  "terminal_enabled",
  "implement_enabled",
  "sync_enabled",
  "sync_interval_minutes",
]);

export function updateConfig(db: DB, patch: Record<string, unknown>): AppConfig {
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!ALLOWED_KEYS.has(key)) continue;
      setConfigValue(db, key, NUMERIC_KEYS.has(key) ? clampInterval(Number(value)) : Boolean(value));
    }
  });
  tx();
  return getConfig(db);
}
