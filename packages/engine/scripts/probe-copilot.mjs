// Discover where GitHub Copilot keeps session data (CLI or editor extension),
// privacy-safe: prints paths, filenames, sizes, and DB keys — never values.
//
// Run from the repo root:  node packages/engine/scripts/probe-copilot.mjs
// Paste the output back so the right Copilot source can be built.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let Database = null;
try {
  Database = require("better-sqlite3");
} catch {
  // optional — only needed to peek at editor state.vscdb keys
}

const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
const macApp = path.join(home, "Library", "Application Support");

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Home-like roots: this user + (under WSL) every Windows user profile. */
function homeRoots() {
  const roots = [home];
  if (process.platform === "linux") {
    let drives = [];
    try {
      drives = fs.readdirSync("/mnt");
    } catch {
      drives = [];
    }
    for (const d of drives) {
      const usersDir = path.join("/mnt", d, "Users");
      let users = [];
      try {
        users = fs.readdirSync(usersDir);
      } catch {
        continue;
      }
      for (const u of users) roots.push(path.join(usersDir, u));
    }
  }
  return roots;
}

/** Editor userData roots (where VS Code-family apps store User/globalStorage). */
function editorUserDataRoots() {
  const names = ["Code", "Code - Insiders", "Cursor", "Windsurf", "Antigravity", "VSCodium"];
  const bases = [appData, macApp, xdg];
  if (process.platform === "linux") {
    for (const r of homeRoots()) {
      bases.push(path.join(r, "AppData", "Roaming"));
    }
  }
  const out = [];
  for (const b of bases) {
    for (const n of names) {
      const root = path.join(b, n);
      if (exists(path.join(root, "User"))) out.push(root);
    }
  }
  return out;
}

function listDataFiles(dir, limit = 40) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(json|jsonl|log|db|vscdb|sqlite)$/i.test(e.name) || /session|chat|history|conversation/i.test(e.name)) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          // ignore
        }
        out.push({ full, size });
      }
    }
  };
  walk(dir, 0);
  return out.slice(0, limit);
}

const SCHEMA = process.argv.includes("--schema");

function shape(v, depth = 0) {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "string") {
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
    return `{ ${Object.entries(v).map(([k, val]) => `${k}: ${shape(val, depth + 1)}`).join(", ")} }`;
  }
  return typeof v;
}

function dumpCliSchema() {
  for (const root of homeRoots()) {
    const dir = path.join(root, ".copilot");
    if (!exists(dir)) continue;
    console.log(`\n===== SCHEMA: ${dir} =====`);

    // Per-session metadata JSON
    const ss = path.join(dir, "session-state");
    let uuids = [];
    try {
      uuids = fs.readdirSync(ss, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      uuids = [];
    }
    for (const u of uuids.slice(0, 5)) {
      const meta = path.join(ss, u.name, "vscode.metadata.json");
      try {
        console.log(`  META ${u.name}: ${shape(JSON.parse(fs.readFileSync(meta, "utf8")))}`);
      } catch {
        // ignore
      }
    }

    // session-store.db schema + one redacted sample row per table
    const dbFile = path.join(dir, "session-store.db");
    if (Database && exists(dbFile)) {
      let db;
      try {
        db = new Database(dbFile, { readonly: true, fileMustExist: true });
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name);
        for (const t of tables) {
          const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
          let count = 0;
          try {
            count = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
          } catch {
            // ignore
          }
          console.log(`  TABLE ${t} (${count} rows): ${cols.join(", ")}`);
          try {
            const row = db.prepare(`SELECT * FROM ${t} LIMIT 1`).get();
            if (row) {
              const red = Object.fromEntries(
                Object.entries(row).map(([k, val]) => [
                  k,
                  Buffer.isBuffer(val)
                    ? `<blob:${val.length}>`
                    : typeof val === "string"
                      ? shape(val)
                      : val,
                ]),
              );
              console.log(`    sample: ${JSON.stringify(red)}`);
            }
          } catch {
            // ignore
          }
        }
      } catch (e) {
        console.log(`  (could not open session-store.db: ${String(e)})`);
      } finally {
        try {
          db?.close();
        } catch {
          // ignore
        }
      }
    }
  }
}

if (SCHEMA) {
  dumpCliSchema();
  console.log("\nDone (schema). Values are redacted; paste this back.");
  process.exit(0);
}

console.log("===== Copilot CLI candidates =====");
let foundCli = false;
for (const root of homeRoots()) {
  for (const sub of [".copilot", path.join(".config", "copilot"), path.join(".config", "github-copilot")]) {
    const dir = path.join(root, sub);
    if (!exists(dir)) continue;
    foundCli = true;
    console.log(`\n--- ${dir} ---`);
    for (const f of listDataFiles(dir)) console.log(`  ${f.size} bytes  ${f.full}`);
  }
}
if (!foundCli) console.log("  (none found)");

console.log("\n===== Editor Copilot storage =====");
let foundEditor = false;
for (const root of editorUserDataRoots()) {
  const gs = path.join(root, "User", "globalStorage");
  let subs = [];
  try {
    subs = fs.readdirSync(gs, { withFileTypes: true });
  } catch {
    subs = [];
  }
  const copilotDirs = subs.filter((e) => e.isDirectory() && /copilot/i.test(e.name));
  if (copilotDirs.length) {
    foundEditor = true;
    console.log(`\n--- ${root} ---`);
    for (const c of copilotDirs) {
      console.log(`  globalStorage/${c.name}:`);
      for (const f of listDataFiles(path.join(gs, c.name), 20)) console.log(`    ${f.size} bytes  ${f.full}`);
    }
  }

  // Peek at state.vscdb keys mentioning copilot/chat (global + per-workspace).
  if (Database) {
    const dbs = [path.join(gs, "state.vscdb")];
    const wsRoot = path.join(root, "User", "workspaceStorage");
    try {
      for (const e of fs.readdirSync(wsRoot, { withFileTypes: true })) {
        if (e.isDirectory()) dbs.push(path.join(wsRoot, e.name, "state.vscdb"));
      }
    } catch {
      // ignore
    }
    for (const dbFile of dbs) {
      if (!exists(dbFile)) continue;
      let db;
      try {
        db = new Database(dbFile, { readonly: true, fileMustExist: true });
        const rows = db
          .prepare("SELECT key, length(value) AS len FROM ItemTable WHERE lower(key) LIKE '%copilot%' OR lower(key) LIKE '%chat%'")
          .all();
        if (rows.length) {
          foundEditor = true;
          console.log(`\n  keys in ${dbFile}:`);
          for (const r of rows.sort((a, b) => b.len - a.len).slice(0, 30)) {
            console.log(`    ${r.len} bytes  ${r.key}`);
          }
        }
      } catch {
        // locked / unreadable
      } finally {
        try {
          db?.close();
        } catch {
          // ignore
        }
      }
    }
  }
}
if (!foundEditor) console.log("  (none found)");

console.log("\nDone. Paste this output (paths, filenames, sizes, and DB keys only — no values).");
