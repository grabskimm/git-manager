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
import { deriveStatus } from "./transcript.js";
import { normalizeToPlatform } from "./antigravity.js";

const home = os.homedir();
const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");

/** Candidate GitHub Copilot CLI data roots (incl. WSL-mounted Windows users). */
function copilotRoots(): string[] {
  const candidates = [
    path.join(home, ".copilot"),
    path.join(xdg, "copilot"),
    path.join(xdg, "github-copilot"),
  ];
  if (process.platform === "linux") {
    let drives: string[] = [];
    try {
      drives = fs.readdirSync("/mnt");
    } catch {
      drives = [];
    }
    for (const drive of drives) {
      const usersDir = path.join("/mnt", drive, "Users");
      let users: string[] = [];
      try {
        users = fs.readdirSync(usersDir);
      } catch {
        continue;
      }
      for (const u of users) candidates.push(path.join(usersDir, u, ".copilot"));
    }
  }
  return candidates.filter((d) => {
    try {
      return fs.existsSync(path.join(d, "session-state"));
    } catch {
      return false;
    }
  });
}

interface CopilotMeta {
  workspaceFolder?: { folderPath?: string };
  repositoryProperties?: { repositoryPath?: string };
  created?: number;
  modified?: number;
}

/** Build a session from one Copilot CLI metadata record. Exported for testing. */
export function sessionFromMeta(
  id: string,
  meta: CopilotMeta,
  fallbackMs: number,
): AgentSession | null {
  const rawCwd = meta.workspaceFolder?.folderPath || meta.repositoryProperties?.repositoryPath || "";
  const cwd = rawCwd ? normalizeToPlatform(rawCwd) : "";
  const created = typeof meta.created === "number" ? meta.created : undefined;
  const modified = typeof meta.modified === "number" ? meta.modified : undefined;
  const lastMs = modified ?? created ?? fallbackMs;
  return {
    id,
    source: "copilot",
    cwd,
    status: deriveStatus(lastMs),
    startedAt: created ? new Date(created).toISOString() : undefined,
    lastEventAt: new Date(lastMs).toISOString(),
    recentEvents: [],
  };
}

/**
 * Read-only GitHub Copilot CLI agent source. The CLI writes one session dir per
 * conversation under ~/.copilot/session-state/<uuid>/ with a vscode.metadata.json
 * carrying the workspace folder and timestamps. Observe-only; binds to repos via
 * the session's cwd (with Windows<->WSL translation). Fails soft when absent.
 */
export class CopilotCliSource implements AgentSource {
  readonly id = "copilot";
  readonly displayName = "GitHub Copilot CLI";
  readonly capabilities = { observe: true, control: false };

  private watcher: FSWatcher | null = null;

  async discoverSessions(): Promise<AgentSession[]> {
    const bySession = new Map<string, AgentSession>();
    for (const root of copilotRoots()) {
      const ss = path.join(root, "session-state");
      let dirs: fs.Dirent[] = [];
      try {
        dirs = fs.readdirSync(ss, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const metaFile = path.join(ss, d.name, "vscode.metadata.json");
        let meta: CopilotMeta;
        let mtimeMs = Date.now();
        try {
          mtimeMs = fs.statSync(metaFile).mtimeMs;
          meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as CopilotMeta;
        } catch {
          continue;
        }
        const session = sessionFromMeta(d.name, meta, mtimeMs);
        if (!session) continue;
        const prev = bySession.get(session.id);
        if (!prev || (session.lastEventAt ?? "") >= (prev.lastEventAt ?? "")) {
          bySession.set(session.id, session);
        }
      }
    }
    return [...bySession.values()];
  }

  subscribe(onEvent: (e: AgentEvent) => void): () => void {
    const dirs = copilotRoots().map((r) => path.join(r, "session-state"));
    if (dirs.length === 0) return () => {};
    this.watcher = chokidar.watch(dirs, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    const emit = (file: string): void => {
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
