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

const RUNNING_WINDOW_MS = 45_000;
const IDLE_WINDOW_MS = 15 * 60_000;
const MAX_RECENT_EVENTS = 12;

/** Locate the Claude Code projects directory, failing soft if absent. */
export function claudeProjectsDir(): string | null {
  const override = process.env.GITMANAGER_CLAUDE_PROJECTS;
  if (override) return fs.existsSync(override) ? override : null;

  const base =
    process.env.CLAUDE_CONFIG_DIR && fs.existsSync(process.env.CLAUDE_CONFIG_DIR)
      ? process.env.CLAUDE_CONFIG_DIR
      : path.join(os.homedir(), ".claude");
  const projects = path.join(base, "projects");
  return fs.existsSync(projects) ? projects : null;
}

function claudeSettingsPath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "settings.json");
}

interface ParsedTranscript {
  sessionId: string;
  cwd: string;
  startedAt?: string;
  lastEventAt?: string;
  events: AgentEvent[];
  mtimeMs: number;
}

/**
 * Parse a Claude Code transcript (.jsonl). The transcript files are the durable
 * contract; we read defensively and skip anything we don't recognize.
 */
function parseTranscript(file: string): ParsedTranscript | null {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = fs.readFileSync(file, "utf8");
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;

  let cwd = "";
  let sessionId = path.basename(file, ".jsonl");
  let startedAt: string | undefined;
  let lastEventAt: string | undefined;
  const events: AgentEvent[] = [];

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.cwd === "string" && obj.cwd) cwd = obj.cwd;
    if (typeof obj.sessionId === "string" && obj.sessionId) sessionId = obj.sessionId;
    const ts =
      (typeof obj.timestamp === "string" && obj.timestamp) ||
      (typeof obj.ts === "string" && obj.ts) ||
      undefined;
    if (ts) {
      if (!startedAt) startedAt = ts;
      lastEventAt = ts;
    }
    const ev = summarizeEvent(obj, ts);
    if (ev) {
      events.push(ev);
      if (events.length > MAX_RECENT_EVENTS) events.shift();
    }
  }

  if (!cwd) return null; // cannot bind without a cwd
  return { sessionId, cwd, startedAt, lastEventAt, events, mtimeMs };
}

function summarizeEvent(
  obj: Record<string, unknown>,
  ts: string | undefined,
): AgentEvent | null {
  const type = typeof obj.type === "string" ? obj.type : "event";
  const when = ts ?? new Date().toISOString();

  // Surface tool calls in particular — they describe what the agent is doing.
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "tool_use"
      ) {
        const p = part as Record<string, unknown>;
        return {
          ts: when,
          type: "tool_use",
          payload: { name: p.name ?? "tool", input: redact(p.input) },
        };
      }
    }
  }
  if (type === "user" || type === "assistant") {
    return { ts: when, type, payload: { role: type } };
  }
  return null;
}

/** Keep payloads small and avoid leaking large blobs into the UI. */
function redact(input: unknown): unknown {
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v;
    }
    return out;
  }
  return input;
}

function deriveStatus(mtimeMs: number): AgentSession["status"] {
  const age = Date.now() - mtimeMs;
  if (age <= RUNNING_WINDOW_MS) return "running";
  if (age <= IDLE_WINDOW_MS) return "idle";
  return "done";
}

/**
 * Claude Code agent source — read half implemented. Discovers sessions from
 * on-disk transcripts (the source of truth) and streams live updates by
 * watching the transcript directory. Control methods throw NotSupported.
 */
export class ClaudeCodeSource implements AgentSource {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";
  readonly capabilities = { observe: true, control: false };

  private watcher: FSWatcher | null = null;

  async discoverSessions(): Promise<AgentSession[]> {
    const dir = claudeProjectsDir();
    if (!dir) return [];

    const files = this.listTranscripts(dir);
    const sessions: AgentSession[] = [];
    for (const file of files) {
      const parsed = parseTranscript(file);
      if (!parsed) continue;
      sessions.push({
        id: parsed.sessionId,
        source: this.id,
        cwd: parsed.cwd,
        status: deriveStatus(parsed.mtimeMs),
        startedAt: parsed.startedAt,
        lastEventAt: parsed.lastEventAt,
        recentEvents: parsed.events,
      });
    }
    // Newest activity first; de-dupe by session id (keep most recent file).
    const bySession = new Map<string, AgentSession>();
    for (const s of sessions.sort((a, b) =>
      (a.lastEventAt ?? "").localeCompare(b.lastEventAt ?? ""),
    )) {
      bySession.set(s.id, s);
    }
    return [...bySession.values()];
  }

  subscribe(onEvent: (e: AgentEvent) => void): () => void {
    const dir = claudeProjectsDir();
    if (!dir) return () => {};

    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    const emit = (file: string): void => {
      if (!file.endsWith(".jsonl")) return;
      onEvent({
        ts: new Date().toISOString(),
        type: "transcript.changed",
        payload: { file },
      });
    };
    this.watcher.on("add", emit).on("change", emit).on("unlink", emit);

    return () => {
      void this.watcher?.close();
      this.watcher = null;
    };
  }

  /**
   * Merge GitManager's hook config into Claude Code settings.json so sessions
   * emit lifecycle events. Best-effort and idempotent; transcripts remain the
   * source of truth, so failure here is non-fatal.
   */
  installHooks(notifyCommand: string): { installed: boolean; reason?: string } {
    const file = claudeSettingsPath();
    let settings: Record<string, unknown> = {};
    try {
      if (fs.existsSync(file)) {
        settings = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      }
    } catch (err) {
      return { installed: false, reason: (err as Error).message };
    }

    const hooks = (settings.hooks as Record<string, unknown>) ?? {};
    const hookEntry = {
      hooks: [{ type: "command", command: notifyCommand }],
    };
    // Add a GitManager notifier on the key lifecycle events if not already there.
    for (const event of ["SessionStart", "Stop", "PostToolUse"]) {
      const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      const already = list.some(
        (h) =>
          JSON.stringify(h).includes("gitmanager") ||
          JSON.stringify(h).includes(notifyCommand),
      );
      if (!already) list.push(hookEntry);
      hooks[event] = list;
    }
    settings.hooks = hooks;

    try {
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
      return { installed: true };
    } catch (err) {
      return { installed: false, reason: (err as Error).message };
    }
  }

  private listTranscripts(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string, depth: number): void => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
      }
    };
    walk(dir, 0);
    return out;
  }

  // ---- control half: declared, unimplemented in v1 ----
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
