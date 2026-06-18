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

// Candidate Antigravity userData roots across platforms.
const roots = [
  path.join(appData, "Antigravity"),
  path.join(localAppData, "Antigravity"),
  path.join(xdg, "Antigravity"),
  path.join(macApp, "Antigravity"),
  path.join(home, ".antigravity"),
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
