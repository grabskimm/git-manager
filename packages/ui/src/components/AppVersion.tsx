import { useEffect, useState } from "react";
import { api } from "../api";
import { desktop } from "../desktop";

export interface VersionInfo {
  version: string;
  build: string | null;
}

/**
 * Resolve the running app version from the single source of truth.
 *
 * Desktop: the shell injects the manifest version (and build SHA) synchronously.
 * Web/CLI: read it from the engine's `/api/ping`. As a last resort fall back to
 * the build-time constant injected by Vite. No hardcoded version lives here.
 */
export function useVersion(): VersionInfo | null {
  const d = desktop();
  const [info, setInfo] = useState<VersionInfo | null>(
    d ? { version: d.version, build: d.build } : null,
  );

  useEffect(() => {
    if (d) return; // desktop value is authoritative and already set
    let alive = true;
    api
      .ping()
      .then((p) => {
        if (alive) setInfo({ version: p.version, build: p.build ?? null });
      })
      .catch(() => {
        if (alive && window.__APP_VERSION__) {
          setInfo({ version: window.__APP_VERSION__, build: null });
        }
      });
    return () => {
      alive = false;
    };
  }, [d]);

  return info;
}

/** Version label for the sidebar footer: `v{semver}`, build SHA on hover. */
export function AppVersion() {
  const info = useVersion();
  if (!info) return null;
  const tooltip = info.build
    ? `v${info.version} (build ${info.build})`
    : `v${info.version}`;
  return (
    <span className="app-version mono" title={tooltip}>
      v{info.version}
    </span>
  );
}
