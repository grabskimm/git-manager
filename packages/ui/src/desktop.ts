/**
 * Bridge to the desktop (Electron) shell.
 *
 * In the desktop build, the preload script exposes `window.__GM_DESKTOP__` via a
 * locked-down contextBridge. In the browser/CLI build the object is absent, so
 * every consumer must treat the desktop bridge as optional and degrade to the
 * web behaviour (read the version from `/api/ping`, no in-app updater).
 */

export interface DesktopUpdateInfo {
  version: string;
  /** Link to the release notes / changelog entry for this version. */
  notesUrl?: string;
  /**
   * When true, the platform can't self-install (e.g. an unsigned macOS build):
   * the UI should offer a manual download from the release page rather than an
   * in-app "Update now" / "Relaunch".
   */
  manual?: boolean;
}

export interface DesktopUpdateProgress {
  percent: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

export interface DesktopBridge {
  readonly isDesktop: true;
  /** App version (semver) — the single source of truth, from the app manifest. */
  readonly version: string;
  /** Short build SHA, when the build injected one. */
  readonly build: string | null;
  /** Node `process.platform` of the host (e.g. "darwin", "win32", "linux"). */
  readonly platform: string;

  /** Manually trigger an update check (startup checks happen automatically). */
  checkForUpdates(): Promise<void>;
  /** Begin downloading an available update. */
  downloadUpdate(): Promise<void>;
  /** Quit and install a downloaded update, relaunching into the new version. */
  installUpdate(): Promise<void>;
  /** Open the per-OS logs folder in the system file manager. */
  openLogsFolder(): Promise<void>;

  /** A newer version is available. Returns an unsubscribe function. */
  onUpdateAvailable(cb: (info: DesktopUpdateInfo) => void): () => void;
  /** Download progress while an update is being fetched. */
  onUpdateProgress(cb: (p: DesktopUpdateProgress) => void): () => void;
  /** Update fully downloaded and ready to install. */
  onUpdateDownloaded(cb: (info: DesktopUpdateInfo) => void): () => void;
  /** An error occurred during checking/downloading. */
  onUpdateError(cb: (message: string) => void): () => void;
}

declare global {
  interface Window {
    __GM_DESKTOP__?: DesktopBridge;
    /** Build-time version constant, injected by Vite (web build fallback). */
    __APP_VERSION__?: string;
  }
}

/** The desktop bridge, or null when running in the browser/CLI. */
export function desktop(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.__GM_DESKTOP__ ?? null;
}

export function isDesktop(): boolean {
  return desktop() !== null;
}
