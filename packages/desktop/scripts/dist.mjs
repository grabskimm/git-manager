// Local packaging wrapper for the desktop app, mirroring the CI packaging steps.
//
// electron-builder asar-packing fails on the workspace symlink to
// @git-manager/engine ("… must be under packages/desktop/"). CI avoids this by
// staging a real, self-contained copy of the production deps under
// packages/desktop before packaging. This script does the same for local
// `npm run desktop:dist` / `desktop:pack`, then restores the workspace dev tree
// (re-linking the engine, restoring devDeps) afterward — even on failure.
//
// Extra args are passed through to electron-builder, e.g.
//   node scripts/dist.mjs --dir
//   node scripts/dist.mjs --publish always
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const root = path.resolve(here, "../../..");
const require = createRequire(import.meta.url);

// Resolve the tool CLIs up-front (they live in the repo-root node_modules and
// are unaffected by the packages/desktop staging install below).
const ebCli = require.resolve("electron-builder/cli.js");
const rebuildCli = require.resolve("@electron/rebuild/lib/cli.js");
const ELECTRON_VERSION = "33.2.0";
const passthrough = process.argv.slice(2).join(" ");

const run = (cmd, cwd) => execSync(cmd, { stdio: "inherit", cwd });

run("npm run build", desktop); // compile main/preload

let failed = false;
try {
  // Replace the workspace symlink to @git-manager/engine with a real, self-contained
  // copy so asar can pack it, and rebuild better-sqlite3 for the Electron ABI
  // (node-pty is N-API and ABI-stable, so it's left alone). Mirrors CI.
  run("npm install --omit=dev --install-links --no-save --workspaces=false", desktop);
  run(`node "${rebuildCli}" -v ${ELECTRON_VERSION} -o better-sqlite3 -m .`, desktop);
  run(`node "${ebCli}" ${passthrough}`.trim(), desktop);
} catch {
  failed = true;
} finally {
  // Restore the workspace dev tree: drop the staged (real-copy) node_modules so
  // the relink is clean, then reinstall to re-symlink the engine and devDeps.
  fs.rmSync(path.join(desktop, "node_modules"), { recursive: true, force: true });
  run("npm install", root);
}

process.exit(failed ? 1 : 0);
