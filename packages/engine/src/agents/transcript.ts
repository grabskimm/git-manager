import fs from "node:fs";
import path from "node:path";
import type { AgentEvent } from "./source.js";

export interface ParsedTranscript {
  sessionId: string;
  cwd: string;
  startedAt?: string;
  lastEventAt?: string;
  events: AgentEvent[];
  mtimeMs: number;
}

const MAX_RECENT_EVENTS = 12;

// Different agent tools name the working directory differently. We search for
// any of these (case-insensitive) so one parser covers many providers.
const CWD_KEYS = [
  "cwd",
  "workingdirectory",
  "working_directory",
  "workdir",
  "project_path",
  "projectpath",
  "projectroot",
  "project_root",
  "rootpath",
  "root",
  "folder",
  "directory",
];

const TS_KEYS = ["timestamp", "ts", "time", "createdat", "created_at", "date"];

function looksLikePath(v: unknown): v is string {
  return typeof v === "string" && (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v));
}

/** Depth-limited search for the first value under any of `keys`. */
function deepFind(
  obj: unknown,
  keys: string[],
  predicate: (v: unknown) => boolean,
  depth = 0,
): string | undefined {
  if (depth > 5 || obj === null || typeof obj !== "object") return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.includes(k.toLowerCase()) && predicate(v)) return v as string;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (v && typeof v === "object") {
      const found = deepFind(v, keys, predicate, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function summarizeRecord(
  obj: Record<string, unknown>,
  ts: string,
): AgentEvent | null {
  const type = typeof obj.type === "string" ? obj.type : "event";

  // Surface tool calls from a variety of shapes.
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content ?? obj.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (p.type === "tool_use" || p.type === "function_call" || p.tool) {
          return {
            ts,
            type: "tool_use",
            payload: { name: p.name ?? p.tool ?? "tool" },
          };
        }
      }
    }
  }
  if (typeof obj.tool === "string" || typeof obj.tool_name === "string") {
    return { ts, type: "tool_use", payload: { name: obj.tool ?? obj.tool_name } };
  }
  if (type === "user" || type === "assistant" || type === "message") {
    return { ts, type, payload: { role: obj.role ?? type } };
  }
  return null;
}

/**
 * Tolerant parser for a single transcript file. Handles JSONL (one JSON object
 * per line) and whole-file JSON (object or array of records). Returns null if
 * no working directory can be determined — we cannot bind such a session.
 */
export function parseTranscriptFile(
  file: string,
  fallbackSessionId?: string,
): ParsedTranscript | null {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = fs.readFileSync(file, "utf8");
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }

  const records: Record<string, unknown>[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try whole-file JSON first, then fall back to JSONL.
  let parsedWhole = false;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (Array.isArray(obj)) {
        for (const r of obj) if (r && typeof r === "object") records.push(r as Record<string, unknown>);
      } else if (obj && typeof obj === "object") {
        records.push(obj as Record<string, unknown>);
      }
      parsedWhole = records.length > 0;
    } catch {
      parsedWhole = false;
    }
  }
  if (!parsedWhole) {
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        records.push(JSON.parse(t) as Record<string, unknown>);
      } catch {
        // skip non-JSON noise
      }
    }
  }
  if (records.length === 0) return null;

  let cwd = "";
  let sessionId = fallbackSessionId ?? path.basename(file).replace(/\.[^.]+$/, "");
  let startedAt: string | undefined;
  let lastEventAt: string | undefined;
  const events: AgentEvent[] = [];

  for (const rec of records) {
    if (!cwd) {
      const found = deepFind(rec, CWD_KEYS, looksLikePath);
      if (found) cwd = found;
    }
    const sid = deepFind(rec, ["sessionid", "session_id", "id", "conversationid", "conversation_id"], (v) => typeof v === "string" && (v as string).length > 0);
    if (sid && !fallbackSessionId) sessionId = sid;

    const ts = deepFind(rec, TS_KEYS, (v) => typeof v === "string");
    const when = ts ?? new Date(mtimeMs).toISOString();
    if (ts) {
      if (!startedAt) startedAt = ts;
      lastEventAt = ts;
    }
    const ev = summarizeRecord(rec, when);
    if (ev) {
      events.push(ev);
      if (events.length > MAX_RECENT_EVENTS) events.shift();
    }
  }

  if (!cwd) return null;
  if (!lastEventAt) lastEventAt = new Date(mtimeMs).toISOString();
  return { sessionId, cwd, startedAt, lastEventAt, events, mtimeMs };
}

const RUNNING_WINDOW_MS = 45_000;
const IDLE_WINDOW_MS = 15 * 60_000;

export function deriveStatus(
  mtimeMs: number,
): "running" | "idle" | "done" {
  const age = Date.now() - mtimeMs;
  if (age <= RUNNING_WINDOW_MS) return "running";
  if (age <= IDLE_WINDOW_MS) return "idle";
  return "done";
}

/** Recursively collect files matching a pattern, depth-limited and fail-soft. */
export function collectFiles(dir: string, pattern: RegExp, maxDepth = 5): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && pattern.test(e.name)) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}
