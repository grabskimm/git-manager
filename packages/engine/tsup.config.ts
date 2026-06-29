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
  // Only keep native modules external; they cannot be bundled into JS.
  external: ["better-sqlite3", "node-pty"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
