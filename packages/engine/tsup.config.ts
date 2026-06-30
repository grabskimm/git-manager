import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Bundle all pure-JS dependencies into the dist so the engine is
  // self-contained. This is required for the desktop install: the engine runs
  // from `app.asar.unpacked` but its node_modules (fastify, ws, etc.) live
  // inside `app.asar`. Electron patches the CJS `require` resolver to cross
  // that boundary transparently, but the ESM `import` resolver is NOT patched —
  // so external ESM imports throw ERR_MODULE_NOT_FOUND when the
  // engine is invoked via `gitm` (ELECTRON_RUN_AS_NODE) or from a plain Node.
  // tsup keeps node_modules external by default; noExternal opts specific
  // packages back in for bundling. Only keep native modules external; they
  // cannot be bundled into JS. Cloud SDKs are loaded via loadDep() with a
  // runtime string so esbuild can't bundle them — they degrade gracefully.
  noExternal: ["fastify", "@fastify/static", "ws", "chokidar"],
  external: ["better-sqlite3", "node-pty"],
  // fastify and its deps (avvio) are CJS and use dynamic require() of Node.js
  // builtins (e.g. require('events')). When bundled into ESM, esbuild's
  // synthetic __require shim checks `typeof require !== "undefined"` — true
  // only if a real `require` exists. shims:true adds __dirname but not require;
  // we inject `require` via the banner so __require resolves builtins correctly.
  // Alias avoids re-declaring 'createRequire' which esbuild also imports.
  shims: true,
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __cjsRequire } from 'module';
const require = __cjsRequire(import.meta.url);`,
  },
});
