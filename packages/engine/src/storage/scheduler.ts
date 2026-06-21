import type { DB } from "../db.js";
import { getConfig } from "../config.js";
import { listRepos } from "../store.js";
import { enabledBackends, loadStorageConfig } from "./config.js";
import { pushRepo, type RepoLike } from "./sync.js";

/**
 * Drives scheduled backups. Opt-in via `sync_enabled`; interval from
 * `sync_interval_minutes`. Each tick backs up every tracked repo to all enabled
 * backends. Re-armed from config via syncWithConfig(). Never throws.
 */
export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private db: DB) {}

  syncWithConfig(): void {
    const cfg = getConfig(this.db);
    this.stop();
    if (!cfg.sync_enabled) return;
    const ms = Math.max(1, cfg.sync_interval_minutes) * 60_000;
    this.timer = setInterval(() => void this.tick(), ms);
    if (this.timer.unref) this.timer.unref();
  }

  /** Back up all tracked repos to all enabled backends. */
  async tick(): Promise<void> {
    if (this.running) return; // never overlap ticks
    this.running = true;
    try {
      const backends = enabledBackends(loadStorageConfig());
      if (backends.length === 0) return;
      for (const repo of listRepos(this.db) as RepoLike[]) {
        try {
          await pushRepo(backends, repo);
        } catch {
          // one repo failing never aborts the rest
        }
      }
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
