import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import {
  type AgentEvent,
  type AgentSession,
  type AgentSource,
  NotSupported,
} from "./source.js";
import { collectFiles, deriveStatus, parseTranscriptFile } from "./transcript.js";

export interface ProviderConfig {
  id: string;
  displayName: string;
  /** Candidate base directories to scan for transcripts (any that exist). */
  baseDirs: string[];
  /** Which files in those directories are transcripts. */
  filePattern: RegExp;
}

/**
 * A read-only agent source for any tool that writes JSON/JSONL session
 * transcripts to disk. Discovery and binding work the same as Claude Code; the
 * parser is tolerant of differing field names so one implementation covers many
 * providers (Codex, Antigravity, etc.). Fails soft when a provider isn't
 * installed — it simply contributes no sessions. Control is unsupported.
 */
export class GenericTranscriptSource implements AgentSource {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities = { observe: true, control: false };

  private watcher: FSWatcher | null = null;

  constructor(private config: ProviderConfig) {
    this.id = config.id;
    this.displayName = config.displayName;
  }

  private existingDirs(): string[] {
    return this.config.baseDirs.filter((d) => {
      try {
        return fs.existsSync(d) && fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
  }

  async discoverSessions(): Promise<AgentSession[]> {
    const dirs = this.existingDirs();
    const files: string[] = [];
    for (const d of dirs) files.push(...collectFiles(d, this.config.filePattern));

    const bySession = new Map<string, AgentSession>();
    for (const file of files) {
      const parsed = parseTranscriptFile(file);
      if (!parsed) continue;
      const session: AgentSession = {
        id: parsed.sessionId,
        source: this.id,
        cwd: parsed.cwd,
        status: deriveStatus(parsed.mtimeMs),
        startedAt: parsed.startedAt,
        lastEventAt: parsed.lastEventAt,
        recentEvents: parsed.events,
      };
      // Keep the most recently active file per session id.
      const prev = bySession.get(session.id);
      if (!prev || (session.lastEventAt ?? "") >= (prev.lastEventAt ?? "")) {
        bySession.set(session.id, session);
      }
    }
    return [...bySession.values()];
  }

  subscribe(onEvent: (e: AgentEvent) => void): () => void {
    const dirs = this.existingDirs();
    if (dirs.length === 0) return () => {};
    this.watcher = chokidar.watch(dirs, {
      ignoreInitial: true,
      depth: 5,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    const emit = (file: string): void => {
      if (!this.config.filePattern.test(path.basename(file))) return;
      onEvent({ ts: new Date().toISOString(), type: "transcript.changed", payload: { file } });
    };
    this.watcher.on("add", emit).on("change", emit).on("unlink", emit);
    return () => {
      void this.watcher?.close();
      this.watcher = null;
    };
  }

  start(): Promise<AgentSession> {
    throw new NotSupported("start");
  }
  stop(): Promise<void> {
    throw new NotSupported("stop");
  }
  resume(): Promise<void> {
    throw new NotSupported("resume");
  }
}

const home = os.homedir();

/**
 * Best-effort provider registry. Locations are detected and fail soft — if a
 * tool isn't installed, its source yields nothing. Add new providers here as
 * their on-disk contracts stabilize; never promise universal coverage.
 */
export function defaultGenericProviders(): ProviderConfig[] {
  return [
    {
      id: "codex",
      displayName: "OpenAI Codex",
      baseDirs: [path.join(home, ".codex", "sessions"), path.join(home, ".codex")],
      filePattern: /\.jsonl$/,
    },
    // Antigravity is handled by the dedicated AntigravitySource (SQLite), not
    // this JSON/JSONL generic reader.
    {
      id: "gemini-cli",
      displayName: "Gemini CLI",
      baseDirs: [path.join(home, ".gemini", "tmp"), path.join(home, ".gemini")],
      filePattern: /\.(jsonl|json)$/,
    },
  ];
}
