import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DB } from "../db.js";
import { getConfig } from "../config.js";
import { currentBranch, repoToplevel } from "../git.js";
import { resolveIdentity } from "../identity.js";
import {
  findOpenPrByHead,
  getRepo,
  listSessions,
  listSourceDirs,
  markStaleSessionsDone,
  upsertSession,
} from "../store.js";
import type { AgentSessionRow } from "../types.js";
import type { WsHub } from "../ws.js";
import { ClaudeCodeSource } from "./claudeCode.js";
import { GenericTranscriptSource, defaultGenericProviders } from "./genericSource.js";
import { AntigravitySource } from "./antigravity.js";
import type { AgentSession, AgentSource } from "./source.js";

/**
 * Owns the agent sources, binds discovered sessions to ingested repos/PRs via
 * §8 identity, persists them, and pushes live updates. Opt-in via config
 * (`agent_observe_enabled`).
 */
export class AgentManager {
  private sources: AgentSource[];
  private unsubscribers: Array<() => void> = [];
  private enabled = false;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private hub: WsHub,
  ) {
    // Claude Code (with hook support), the dedicated Antigravity source (reads
    // its SQLite state store), plus best-effort generic JSON/JSONL providers
    // (Codex, Gemini CLI, …). Inactive providers contribute nothing.
    this.sources = [
      new ClaudeCodeSource(),
      new AntigravitySource(),
      ...defaultGenericProviders().map((p) => new GenericTranscriptSource(p)),
    ];
  }

  sourceCapabilities(): {
    id: string;
    displayName: string;
    capabilities: AgentSource["capabilities"];
  }[] {
    return this.sources.map((s) => ({
      id: s.id,
      displayName: s.displayName ?? s.id,
      capabilities: s.capabilities,
    }));
  }

  /** Apply current config: enable observation (and hooks) or tear it down. */
  syncWithConfig(): void {
    const cfg = getConfig(this.db);
    if (cfg.agent_observe_enabled && !this.enabled) {
      this.enable();
      void this.refresh();
    } else if (!cfg.agent_observe_enabled && this.enabled) {
      this.disable();
    }
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    for (const source of this.sources) {
      const unsub = source.subscribe(() => this.scheduleRefresh());
      this.unsubscribers.push(unsub);
    }
  }

  disable(): void {
    this.enabled = false;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 500);
  }

  /** Discover, bind, persist, and broadcast all current sessions. */
  async refresh(): Promise<AgentSessionRow[]> {
    if (!this.enabled) return listSessions(this.db);

    // The internal cwd used by GitManager's own `claude --print` subprocesses.
    // Sessions whose cwd matches this path are our own review/chat runs and
    // should never appear as user-facing agent sessions.
    const internalCwd = resolve(
      process.env.GITMANAGER_HOME ?? join(homedir(), ".gitmanager"),
      ".internal",
    );

    // Registered source directories are umbrella folders that *contain* repos,
    // not repos themselves. A session sitting directly in one of them (e.g. the
    // "GitHub" folder) is unbound noise — hide it.
    const sourceDirs = new Set(
      listSourceDirs(this.db).map((d) => resolve(d.path)),
    );
    const isHidden = (cwd: string | null): boolean => {
      if (!cwd) return false;
      const r = resolve(cwd);
      return r === internalCwd || sourceDirs.has(r);
    };

    const activeIds: string[] = [];
    for (const source of this.sources) {
      let sessions: AgentSession[] = [];
      try {
        sessions = (await source.discoverSessions()).filter(
          (s) => !isHidden(s.cwd),
        );
      } catch {
        sessions = [];
      }
      for (const s of sessions) {
        const row = await this.bind(source.id, s);
        upsertSession(this.db, row);
        activeIds.push(row.id);
      }
    }
    markStaleSessionsDone(this.db, activeIds);
    this.hub.broadcast("agents.refreshed", { count: activeIds.length });
    return listSessions(this.db);
  }

  /** Resolve repo/branch/PR binding for a session via §8 identity from cwd. */
  private async bind(
    sourceId: string,
    s: AgentSession,
  ): Promise<AgentSessionRow> {
    let repoId: string | null = null;
    let branch: string | null = null;
    let prId: string | null = null;

    try {
      const top = await repoToplevel(s.cwd);
      if (top) {
        const identity = await resolveIdentity(top);
        if (getRepo(this.db, identity.id)) {
          repoId = identity.id;
          branch = await currentBranch(top);
          if (branch) {
            const pr = findOpenPrByHead(this.db, repoId, branch);
            if (pr) prId = pr.id;
          }
        }
      }
    } catch {
      // unbound session is still reported
    }

    return {
      id: s.id,
      source: sourceId,
      repo_id: repoId,
      branch,
      pr_id: prId,
      status: s.status,
      cwd: s.cwd,
      raw_transcript_path: null,
      started_at: s.startedAt ?? null,
      last_event_at: s.lastEventAt ?? null,
    };
  }

  /** Best-effort hook installation across sources that support it. */
  installHooks(notifyCommand: string): void {
    for (const source of this.sources) {
      const withHooks = source as AgentSource & {
        installHooks?: (cmd: string) => unknown;
      };
      if (typeof withHooks.installHooks === "function") {
        try {
          withHooks.installHooks(notifyCommand);
        } catch {
          // non-fatal
        }
      }
    }
  }
}
