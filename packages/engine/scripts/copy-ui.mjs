import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Copy the built UI bundle into the engine's dist so the engine package is
// self-contained and works when installed globally (npm install -g).
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../ui/dist");
const dest = path.resolve(here, "../dist/ui");

if (fs.existsSync(path.join(src, "index.html"))) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`copy-ui: bundled UI assets -> ${dest}`);
} else {
  console.warn(
    "copy-ui: UI dist not found; build the UI first (npm run build:ui). Engine will serve a placeholder.",
  );
}
