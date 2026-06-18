// Probe Antigravity's VS Code-style SQLite storage to discover WHERE it keeps
// agent/cascade conversations — WITHOUT printing any values (keys + sizes only,
// so your prompts and code never leave the machine).
//
// Run from the repo root:  node packages/engine/scripts/probe-antigravity.mjs
//
// Paste the output back; it tells me the ItemTable keys and the workspace→folder
// mapping I need to build the Antigravity agent source.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let Database;
try {
  Database = require("better-sqlite3");
} catch (err) {
  console.error(
    "Could not load better-sqlite3. Run `npm install` in the repo first, then re-run.\n" +
      String(err),
  );
  process.exit(1);
}

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
const macApp = path.join(home, "Library", "Application Support");

// When running under WSL, the Windows Antigravity data lives on the mounted
// Windows drives (/mnt/c/Users/<user>/AppData/Roaming/Antigravity). Enumerate
// every Windows user profile we can see.
function wslWindowsRoots() {
  const out = [];
  let drives = [];
  try {
    drives = fs.readdirSync("/mnt");
  } catch {
    return out;
  }
  for (const drive of drives) {
    const usersDir = path.join("/mnt", drive, "Users");
    let users = [];
    try {
      users = fs.readdirSync(usersDir);
    } catch {
      continue;
    }
    for (const u of users) {
      out.push(
        path.join(usersDir, u, "AppData", "Roaming", "Antigravity"),
        path.join(usersDir, u, "AppData", "Local", "Antigravity"),
      );
    }
  }
  return out;
}

// Candidate Antigravity userData roots across platforms (incl. WSL→Windows).
const roots = [
  path.join(appData, "Antigravity"),
  path.join(localAppData, "Antigravity"),
  path.join(xdg, "Antigravity"),
  path.join(macApp, "Antigravity"),
  path.join(home, ".antigravity"),
  ...wslWindowsRoots(),
].filter((d) => {
  try {
    return fs.existsSync(path.join(d, "User"));
  } catch {
    return false;
  }
});

if (roots.length === 0) {
  console.log("No Antigravity userData root with a User/ folder was found.");
  process.exit(0);
}

const KEY_HINT = /antigravity|cascade|chat|conversation|agent|session|composer|history|thread/i;

// With --schema, print the redacted STRUCTURE of these keys (field names,
// timestamps, ids, paths shown; long free-text replaced with <str:NN>).
const SCHEMA = process.argv.includes("--schema");
const SCHEMA_KEYS = new Set([
  "antigravityUnifiedStateSync.trajectorySummaries",
  "antigravityUnifiedStateSync.sidebarWorkspaces",
  "antigravityUnifiedStateSync.agentPreferences",
  "chat.ChatSessionStore.index",
]);

function shape(v, depth = 0) {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "string") {
    // Reveal structural strings (uris, ISO/epoch timestamps, ids, short tokens);
    // redact long free text so prompts/titles don't leak.
    if (
      /^file:\/\//.test(v) ||
      /^[a-z]:[\\/]/i.test(v) ||
      /^\/(mnt|home|Users)/.test(v) ||
      /^\d{4}-\d\dT/.test(v) ||
      /^\d{10,13}$/.test(v) ||
      /^[0-9a-f-]{8,40}$/i.test(v) ||
      v.length <= 32
    ) {
      return JSON.stringify(v);
    }
    return `"<str:${v.length}>"`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (depth > 4) return `[${v.length}…]`;
    return `[${v.length}] e.g. ${shape(v[0], depth + 1)}`;
  }
  if (typeof v === "object") {
    if (depth > 4) return "{…}";
    const parts = Object.entries(v).map(([k, val]) => `${k}: ${shape(val, depth + 1)}`);
    return `{ ${parts.join(", ")} }`;
  }
  return typeof v;
}

function dumpSchema(db) {
  for (const key of SCHEMA_KEYS) {
    let row;
    try {
      row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
    } catch {
      continue;
    }
    if (!row) continue;
    let parsed;
    try {
      const raw = Buffer.isBuffer(row.value) ? row.value.toString("utf8") : String(row.value);
      parsed = JSON.parse(raw);
    } catch {
      diagnose(key, row.value);
      continue;
    }
    console.log(`  SCHEMA ${key}:\n    ${shape(parsed)}`);
  }
}

function hexHead(buf, n = 64) {
  return buf.subarray(0, n).toString("hex").replace(/(..)/g, "$1 ").trim();
}
function preview(buf, n = 100) {
  let s = "";
  for (let i = 0; i < Math.min(n, buf.length); i++) {
    const c = buf[i];
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : ".";
  }
  return s;
}

// Identify the encoding of a non-JSON value (protobuf? base64? gzip?) without
// dumping full content — just the head bytes and a few decode probes.
function diagnose(key, value) {
  const zlib = require("node:zlib");
  const isBlob = Buffer.isBuffer(value);
  const buf = isBlob ? value : Buffer.from(String(value), "utf8");
  console.log(`  RAW ${key}: type=${isBlob ? "BLOB" : "TEXT"} bytes=${buf.length}`);
  console.log(`    hex  : ${hexHead(buf)}`);
  console.log(`    ascii: ${preview(buf)}`);

  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      const z = zlib.gunzipSync(buf);
      console.log(`    gunzip-> bytes=${z.length} ascii=${preview(z, 140)}`);
    } catch (e) {
      console.log(`    gunzip failed: ${e.message}`);
    }
  }

  if (!isBlob) {
    const s = String(value).trim();
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(s) && s.length > 8) {
      try {
        const d = Buffer.from(s, "base64");
        console.log(`    base64-> bytes=${d.length} hex=${hexHead(d, 32)} ascii=${preview(d)}`);
        if (d[0] === 0x1f && d[1] === 0x8b) {
          const z = zlib.gunzipSync(d);
          console.log(`    base64+gunzip-> ascii=${preview(z, 140)}`);
        }
      } catch {
        // not base64
      }
    }
  }
}

function dumpVscdb(file) {
  console.log(`\n--- state.vscdb: ${file} ---`);
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.log(`  (could not open: ${String(err)})`);
    return;
  }
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    console.log(`  tables: ${tables.join(", ") || "(none)"}`);

    for (const table of tables) {
      // VS Code uses ItemTable(key, value) and sometimes cursors etc.
      let cols;
      try {
        cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      } catch {
        continue;
      }
      if (!cols.includes("key")) {
        console.log(`  [${table}] columns: ${cols.join(", ")}`);
        continue;
      }
      const valueCol = cols.includes("value") ? "value" : null;
      const rows = db
        .prepare(
          `SELECT key${valueCol ? `, length(${valueCol}) AS len` : ""} FROM ${table}`,
        )
        .all();
      console.log(`  [${table}] ${rows.length} keys:`);
      const interesting = rows.filter((r) => KEY_HINT.test(String(r.key)));
      const show = interesting.length ? interesting : rows;
      for (const r of show.sort((a, b) => (b.len ?? 0) - (a.len ?? 0)).slice(0, 60)) {
        const mark = KEY_HINT.test(String(r.key)) ? " <-- likely" : "";
        console.log(`    ${r.len ?? "?"} bytes  ${r.key}${mark}`);
      }
      if (!interesting.length && rows.length > 60) {
        console.log(`    …and ${rows.length - 60} more`);
      }
    }
    if (SCHEMA) dumpSchema(db);
  } finally {
    db.close();
  }
}

for (const root of roots) {
  console.log(`\n========== ROOT: ${root} ==========`);

  // Global storage DB
  const globalDb = path.join(root, "User", "globalStorage", "state.vscdb");
  if (fs.existsSync(globalDb)) dumpVscdb(globalDb);

  // Per-workspace DBs + their folder mapping (gives us the cwd)
  const wsRoot = path.join(root, "User", "workspaceStorage");
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(wsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    workspaces = [];
  }
  for (const ws of workspaces) {
    const dir = path.join(wsRoot, ws.name);
    // workspace.json maps the hash -> the actual folder URI (the cwd!)
    const metaFile = path.join(dir, "workspace.json");
    let folder = "(no workspace.json)";
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      folder = meta.folder || meta.workspace || JSON.stringify(meta);
    } catch {
      // ignore
    }
    console.log(`\n--- workspace ${ws.name}\n    folder: ${folder}`);
    const wsDb = path.join(dir, "state.vscdb");
    if (fs.existsSync(wsDb)) dumpVscdb(wsDb);
  }
}

console.log("\nDone. Paste this output (keys + folder mappings only — no values were read).");
