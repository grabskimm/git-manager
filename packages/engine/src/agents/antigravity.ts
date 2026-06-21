import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import chokidar, { type FSWatcher } from "chokidar";
import {
  type AgentEvent,
  type AgentSession,
  type AgentSource,
  NotSupported,
} from "./source.js";
import { deriveStatus } from "./transcript.js";
import { collectVarints, extractStrings, topLevelEntries } from "./protobuf.js";

const require = createRequire(import.meta.url);

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
const macApp = path.join(home, "Library", "Application Support");

/** Antigravity userData roots (with a User/ subdir), across platforms + WSL. */
function antigravityRoots(): string[] {
  const candidates = [
    path.join(appData, "Antigravity"),
    path.join(localAppData, "Antigravity"),
    path.join(xdg, "Antigravity"),
    path.join(macApp, "Antigravity"),
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
      for (const u of users) {
        candidates.push(path.join(usersDir, u, "AppData", "Roaming", "Antigravity"));
      }
    }
  }
  return candidates.filter((d) => {
    try {
      return fs.existsSync(path.join(d, "User", "globalStorage", "state.vscdb"));
    } catch {
      return false;
    }
  });
}

/**
 * Normalize a folder reference (file:// URI, Windows path, /mnt path) to a real
 * path on the platform the engine runs on, translating Windows<->WSL as needed.
 */
export function normalizeToPlatform(raw: string): string {
  let p = raw.trim();
  if (p.startsWith("file://")) {
    p = p.slice("file://".length);
    try {
      p = decodeURIComponent(p);
    } catch {
      // leave as-is
    }
  }
  p = p.replace(/\\/g, "/");
  // "/m:/git/x" -> "m:/git/x"
  p = p.replace(/^\/([a-zA-Z]:)/, "$1");

  const driveMatch = /^([a-zA-Z]):\/(.*)$/.exec(p);
  const mntMatch = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);

  if (process.platform === "win32") {
    if (mntMatch) return `${mntMatch[1].toUpperCase()}:\\${mntMatch[2].replace(/\//g, "\\")}`;
    if (driveMatch) return `${driveMatch[1].toUpperCase()}:\\${driveMatch[2].replace(/\//g, "\\")}`;
    return p.replace(/\//g, "\\");
  }
  // linux / darwin
  if (driveMatch) return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
  return p;
}

/** Canonical, comparable form (ignores drive vs /mnt and case). */
function canonical(p: string): string {
  let c = p.replace(/\\/g, "/").toLowerCase();
  const mnt = /^\/mnt\/([a-z])\/(.*)$/.exec(c);
  if (mnt) c = `${mnt[1]}:/${mnt[2]}`;
  return c.replace(/\/+$/, "");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function plausibleMs(v: bigint): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n >= 1_500_000_000_000 && n <= 2_200_000_000_000) return n; // ms (2017..2039)
  if (n >= 1_500_000_000 && n <= 2_200_000_000) return n * 1000; // s
  return null;
}

export interface ParsedTrajectory {
  id: string;
  cwd: string;
  startedAt?: string;
  lastEventAt?: string;
}

/**
 * Pure extraction: decode the base64 trajectorySummaries protobuf and emit one
 * session per trajectory, resolving cwd against the known workspace folders.
 * Exported for testing.
 */
export function parseTrajectories(
  trajB64: string,
  knownFolders: string[],
  fallbackMs: number,
): ParsedTrajectory[] {
  let buf: Buffer;
  try {
    buf = Buffer.from(trajB64, "base64");
  } catch {
    return [];
  }
  const known = knownFolders
    .map((f) => {
      const platform = normalizeToPlatform(f);
      const canon = canonical(platform);
      // Match the folder as a whole path component: a filename-continuation
      // char on either side means it's a different name (github vs github-x).
      const re = new RegExp(`(?<![a-z0-9._-])${escapeRegExp(canon)}(?![a-z0-9._-])`);
      return { platform, canon, re };
    })
    .filter((k) => k.canon.length > 1)
    .sort((a, b) => b.canon.length - a.canon.length); // longest (most specific) first

  const entries = topLevelEntries(buf);
  const out: ParsedTrajectory[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const strings = extractStrings(entry);
    const varints = collectVarints(entry);

    const id = strings.find((s) => UUID_RE.test(s)) ?? "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    // cwd: a known workspace folder may appear ANYWHERE inside a string (e.g.
    // embedded in a terminal prompt like "PS M:\git\tf-avd-module> ..."), so
    // match it as a whole path component (boundaries on both sides), longest
    // (most specific) folder first.
    let cwd = "";
    const canonStrings = strings.map(canonical);
    for (const k of known) {
      if (canonStrings.some((cs) => k.re.test(cs))) {
        cwd = k.platform;
        break;
      }
    }
    if (!cwd) {
      // Last resort: pull an embedded absolute path out of any string.
      for (const s of strings) {
        const m = /([a-zA-Z]:[\\/][^\s"'<>|]+|\/(?:mnt|home|Users)\/[^\s"'<>|]+|file:\/\/[^\s"']+)/.exec(s);
        if (m) {
          cwd = normalizeToPlatform(m[1]);
          break;
        }
      }
    }

    const times = varints.map(plausibleMs).filter((n): n is number => n !== null);
    const lastMs = times.length ? Math.max(...times) : fallbackMs;
    const firstMs = times.length ? Math.min(...times) : fallbackMs;

    out.push({
      id,
      cwd,
      startedAt: new Date(firstMs).toISOString(),
      lastEventAt: new Date(lastMs).toISOString(),
    });
  }

  // Most recently active first; cap to avoid flooding the panel.
  out.sort((a, b) => (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""));
  return out.slice(0, 40);
}

/** Collect known workspace folders for a root (sidebarWorkspaces + workspace.json). */
function knownFoldersForRoot(root: string, sidebarB64: string | null): string[] {
  const folders = new Set<string>();
  if (sidebarB64) {
    try {
      for (const s of extractStrings(Buffer.from(sidebarB64, "base64"))) {
        if (s.startsWith("file://")) folders.add(s);
      }
    } catch {
      // ignore
    }
  }
  const wsRoot = path.join(root, "User", "workspaceStorage");
  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(wsRoot, { withFileTypes: true });
  } catch {
    dirs = [];
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(wsRoot, d.name, "workspace.json"), "utf8"));
      if (typeof meta.folder === "string") folders.add(meta.folder);
    } catch {
      // no/invalid workspace.json
    }
  }
  return [...folders];
}

/**
 * Read-only Antigravity (Windsurf/Codeium-based VS Code fork) agent source.
 * Reads agent "trajectories" from its SQLite state store (state.vscdb), which
 * holds base64-encoded protobuf — no JSON transcripts exist. Observe-only.
 */
export class AntigravitySource implements AgentSource {
  readonly id = "antigravity";
  readonly displayName = "Antigravity";
  readonly capabilities = { observe: true, control: false };

  private watcher: FSWatcher | null = null;

  async discoverSessions(): Promise<AgentSession[]> {
    let Database: typeof import("better-sqlite3");
    try {
      Database = require("better-sqlite3");
    } catch {
      return []; // native module unavailable — contribute nothing
    }

    const sessions: AgentSession[] = [];
    for (const root of antigravityRoots()) {
      const dbFile = path.join(root, "User", "globalStorage", "state.vscdb");
      let traj: string | null = null;
      let sidebar: string | null = null;
      let mtimeMs = Date.now();
      let db: import("better-sqlite3").Database | null = null;
      try {
        mtimeMs = fs.statSync(dbFile).mtimeMs;
        db = new Database(dbFile, { readonly: true, fileMustExist: true });
        const get = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
        const row1 = get.get("antigravityUnifiedStateSync.trajectorySummaries") as
          | { value: string | Buffer }
          | undefined;
        const row2 = get.get("antigravityUnifiedStateSync.sidebarWorkspaces") as
          | { value: string | Buffer }
          | undefined;
        traj = row1 ? String(row1.value) : null;
        sidebar = row2 ? String(row2.value) : null;
      } catch {
        traj = null;
      } finally {
        try {
          db?.close();
        } catch {
          // ignore
        }
      }
      if (!traj) continue;

      const known = knownFoldersForRoot(root, sidebar);
      for (const t of parseTrajectories(traj, known, mtimeMs)) {
        const lastMs = t.lastEventAt ? Date.parse(t.lastEventAt) : mtimeMs;
        sessions.push({
          id: t.id,
          source: this.id,
          cwd: t.cwd,
          status: deriveStatus(lastMs),
          startedAt: t.startedAt,
          lastEventAt: t.lastEventAt,
          recentEvents: [],
        });
      }
    }
    return sessions;
  }

  subscribe(onEvent: (e: AgentEvent) => void): () => void {
    const dirs = antigravityRoots().map((r) => path.join(r, "User", "globalStorage"));
    if (dirs.length === 0) return () => {};
    this.watcher = chokidar.watch(dirs, {
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 150 },
    });
    const emit = (file: string): void => {
      if (!path.basename(file).startsWith("state.vscdb")) return;
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
