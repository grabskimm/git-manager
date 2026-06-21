import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const ENGINE = process.env.GITMANAGER_ENGINE || "http://127.0.0.1:4317";

// In dev, Vite serves the UI and proxies API/WebSocket to the engine.
// In production, the engine serves the built bundle on its own origin.
export default defineConfig({
  plugins: [react()],
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
