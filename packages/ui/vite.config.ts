import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const ENGINE = process.env.GITMANAGER_ENGINE || "http://127.0.0.1:4317";

// Single source of truth for the web-build version fallback: the package
// manifest (bumped from the git tag at release). The desktop shell and the
// engine's /api/ping take precedence at runtime; this only matters when neither
// is reachable.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version?: string };
const APP_VERSION = process.env.GITMANAGER_VERSION || pkg.version || "0.0.0";

// In dev, Vite serves the UI and proxies API/WebSocket to the engine.
// In production, the engine serves the built bundle on its own origin.
export default defineConfig({
  plugins: [react()],
  define: {
    "window.__APP_VERSION__": JSON.stringify(APP_VERSION),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: ENGINE, changeOrigin: true },
      "/ws": { target: ENGINE, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
