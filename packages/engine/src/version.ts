import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppVersion {
  /** Semver, e.g. "1.2.3". */
  version: string;
  /** Short commit SHA the build was produced from, when known. */
  build: string | null;
}

let cached: AppVersion | null = null;

/**
 * The single source of truth for the running app's version.
 *
 * Resolution order (first hit wins):
 *  1. `GITMANAGER_VERSION` — injected by the desktop shell / CI from the git tag.
 *  2. the engine's own `package.json` version (bumped from the tag at release).
 *
 * The short build SHA is taken from `GITMANAGER_BUILD_SHA` when present. There
 * is deliberately no second hardcoded version string anywhere in the codebase —
 * `/api/ping`, `/healthz`, the CLI and the sidebar all read from here.
 */
export function appVersion(): AppVersion {
  if (cached) return cached;

  const build = process.env.GITMANAGER_BUILD_SHA?.trim() || null;
  let version = "0.0.0";

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../package.json"), // dist/version.js -> package.json
    path.resolve(here, "../../package.json"), // src/version.ts (tsx/dev) -> package.json
    path.resolve(here, "package.json"),
  ];
  for (const c of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(c, "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version) {
        version = pkg.version;
        break;
      }
    } catch {
      // try the next candidate
    }
  }

  const override = process.env.GITMANAGER_VERSION?.trim();
  if (override) version = override;

  cached = { version, build };
  return cached;
}
