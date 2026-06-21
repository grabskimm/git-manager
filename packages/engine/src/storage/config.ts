import fs from "node:fs";
import path from "node:path";
import { gitmanagerHome } from "../paths.js";
import type { BackendConfig, StorageConfig } from "./backend.js";

function configPath(): string {
  return path.join(gitmanagerHome(), "storage.json");
}

/** Load the storage config (which backends/buckets). No secrets live here —
 * credentials come from each provider's own logged-in auth. */
export function loadStorageConfig(): StorageConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StorageConfig>;
    return { backends: Array.isArray(parsed.backends) ? parsed.backends : [] };
  } catch {
    return { backends: [] };
  }
}

export function saveStorageConfig(cfg: StorageConfig): void {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(configPath(), 0o600);
  } catch {
    // best effort
  }
}

export function enabledBackends(cfg: StorageConfig): BackendConfig[] {
  return cfg.backends.filter((b) => b.enabled);
}
