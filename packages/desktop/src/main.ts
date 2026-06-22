import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { autoUpdater } from "electron-updater";
import log from "electron-log";

// ---------------------------------------------------------------------------
// Logging: server + shell logs land in the per-OS app-data/logs directory
// (%APPDATA%\GitManager\logs, ~/Library/Logs/GitManager, ~/.config/GitManager/logs).
// ---------------------------------------------------------------------------
log.transports.file.level = "info";
log.transports.console.level = "info";
autoUpdater.logger = log;
autoUpdater.autoDownload = false; // the user opts in from the in-app prompt
autoUpdater.autoInstallOnAppQuit = true;

const HOST = "127.0.0.1";
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let engine: ChildProcess | null = null;
let enginePort = 0;
let shuttingDown = false;

const APP_VERSION = app.getVersion();
const BUILD_SHA = process.env.GITMANAGER_BUILD_SHA ?? null;
const NOTES_BASE =
  process.env.GITMANAGER_RELEASE_NOTES_BASE ??
  "https://github.com/grabskimm/git-manager/releases/tag";
const RELEASES_LATEST = "https://github.com/grabskimm/git-manager/releases/latest";

// macOS in-app auto-update needs a Developer ID signature: Squirrel.Mac validates
// the downloaded .app's code signature and refuses an unsigned/ad-hoc build
// ("code has no resources but signature indicates they must be present"). Until the
// mac build is signed + notarized, surface updates on macOS as a MANUAL download
// (open the release page) instead of attempting the in-app install. Windows (NSIS)
// and Linux (AppImage) auto-update fine unsigned. Flip this to false once signing
// is wired up (set the APPLE_* secrets) to re-enable in-app updates on macOS.
const MAC_UPDATE_IS_MANUAL = process.platform === "darwin";

// ---------------------------------------------------------------------------
// Single-instance lock: a second launch focuses the existing window instead of
// spawning a second engine.
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void app.whenReady().then(main);
}

/**
 * Resolve the app icon PNG for the runtime window/taskbar icon. On Windows the
 * packaged exe and on macOS the .app bundle already carry the icon, so this
 * mainly covers dev and the Linux runtime window. Returns undefined if missing.
 */
function appIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, "..", "build", "icon.png"), // dev (dist/ -> build/)
    path.join(process.resourcesPath ?? "", "icon.png"), // packaged (extraResources)
  ];
  return candidates.find((p) => {
    try {
      return p && fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/** Find a free TCP port on loopback by binding to port 0 and reading it back. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}

/** Resolve the engine CLI entry, in dev and in the packaged app. */
function resolveEngineEntry(): string {
  try {
    // Works both in dev (workspace symlink) and packaged (node_modules in asar).
    return require.resolve("@git-manager/engine/dist/cli.js");
  } catch {
    return path.join(app.getAppPath(), "..", "engine", "dist", "cli.js");
  }
}

/**
 * Spawn the GitManager engine on its own Node runtime (Electron's, via
 * ELECTRON_RUN_AS_NODE so native modules built for the Electron ABI load). Bound
 * to loopback on a dynamically chosen free port — never hardcoded — to avoid
 * collisions with a dev server or a second instance.
 */
async function startEngine(): Promise<void> {
  enginePort = await findFreePort();
  const entry = resolveEngineEntry();
  log.info(`starting engine: ${entry} on ${HOST}:${enginePort}`);

  engine = spawn(process.execPath, [entry, "start"], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      GITMANAGER_PORT: String(enginePort),
      GITMANAGER_NO_OPEN: "1", // the desktop shell owns the window; no browser
      GITMANAGER_VERSION: APP_VERSION, // single source of truth, from the tag
      ...(BUILD_SHA ? { GITMANAGER_BUILD_SHA: BUILD_SHA } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  engine.stdout?.on("data", (d: Buffer) => log.info(`[engine] ${d.toString().trimEnd()}`));
  engine.stderr?.on("data", (d: Buffer) => log.warn(`[engine] ${d.toString().trimEnd()}`));
  engine.on("exit", (code, signal) => {
    log.warn(`engine exited (code=${code}, signal=${signal})`);
    engine = null;
    // An unexpected engine death while running is fatal for the app.
    if (!shuttingDown) {
      showFatal(`The GitManager engine stopped unexpectedly (code ${code ?? signal}).`);
    }
  });
}

/** Poll /healthz until the engine reports ready, or time out. */
function waitForEngine(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${HOST}:${enginePort}/healthz`;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      });
      req.on("error", retry);
      req.setTimeout(2000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error("engine did not become ready in time"));
        return;
      }
      setTimeout(attempt, 250);
    };
    attempt();
  });
}

function createSplash(): void {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 240,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    icon: appIconPath(),
    backgroundColor: "#0d1117",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#0d1117;color:#c9d1d9;
    font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;
    justify-content:center;flex-direction:column;gap:14px}
  .logo{width:64px;height:64px}
  .b{font-size:22px;font-weight:700;letter-spacing:0.2px}
  .s{font-size:13px;color:#8b949e}
  .spin{width:22px;height:22px;border:3px solid #30363d;border-top-color:#3fb950;
    border-radius:50%;animation:r .8s linear infinite}
  @keyframes r{to{transform:rotate(360deg)}}
</style></head><body>
  <svg class="logo" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#161b22"/><stop offset="1" stop-color="#090c10"/></linearGradient></defs>
    <rect x="20" y="20" width="984" height="984" rx="225" fill="url(#g)"/>
    <g fill="none" stroke-linecap="round" stroke-width="53">
      <path d="M409.6 245.76 V 778.24" stroke="#3fb950"/>
      <path d="M409.6 286.7 Q 675.84 307.2 675.84 512" stroke="#56d364"/>
      <path d="M675.84 512 Q 675.84 716.8 409.6 737.3" stroke="#56d364"/></g>
    <g stroke="#090c10" stroke-width="26">
      <circle cx="409.6" cy="245.76" r="80" fill="#3fb950"/>
      <circle cx="675.84" cy="512" r="80" fill="#56d364"/>
      <circle cx="409.6" cy="778.24" r="80" fill="#3fb950"/></g>
  </svg>
  <div class="b">GitManager</div>
  <div class="spin"></div>
  <div class="s">Starting local engine&hellip;</div>
</body></html>`;
  void splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/** Escape text destined for an HTML context (the data: fatal-error screen). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Compare a URL against the engine's loopback origin by parsed components. */
function isEngineOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && u.hostname === HOST && u.port === String(enginePort);
  } catch {
    return false;
  }
}

/** Open a URL in the system browser only if it is http(s); otherwise drop it. */
function openExternalSafely(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:") void shell.openExternal(url);
    else log.warn(`refusing to open non-http(s) URL: ${url}`);
  } catch {
    log.warn(`refusing to open malformed URL: ${url}`);
  }
}

/** Best-effort path to the logs directory, for the fatal screen. */
function logsDir(): string {
  try {
    return path.dirname(log.transports.file.getFile().path);
  } catch {
    return app.getPath("logs");
  }
}

function showFatal(message: string): void {
  const win = mainWindow ?? splashWindow;
  // The renderer UI never loaded in this path, so the in-app "Open logs folder"
  // button is unreachable and there's no application menu — print the path itself.
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#0d1117;color:#c9d1d9;
  font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
  flex-direction:column;gap:12px;padding:24px;text-align:center}
  h1{color:#f85149;font-size:18px;margin:0}p{color:#8b949e;max-width:34rem}
  code{color:#c9d1d9;background:#161b22;border:1px solid #30363d;border-radius:6px;
    padding:2px 6px;font-size:12px;word-break:break-all}</style>
</head><body><h1>GitManager could not start</h1><p>${escapeHtml(message)}</p>
<p>See the logs for details:<br><code>${escapeHtml(logsDir())}</code></p></body></html>`;
  if (win && !win.isDestroyed()) {
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.show();
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0d1117",
    title: "GitManager",
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer only ever loads our own loopback origin; keep it hardened.
      webSecurity: true,
    },
  });

  // Lock the webview down: no new windows, no navigation off the loopback origin.
  // Only ever hand http(s) URLs to the OS — never javascript:/file:/custom schemes.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url); // links (release notes etc.) open in the browser
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!isEngineOrigin(url)) {
      e.preventDefault();
      openExternalSafely(url);
    }
  });

  void mainWindow.loadURL(`http://${HOST}:${enginePort}/`);

  mainWindow.once("ready-to-show", () => {
    splashWindow?.close();
    splashWindow = null;
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function main(): Promise<void> {
  registerIpc();
  createSplash();
  try {
    await startEngine();
    await waitForEngine();
  } catch (err) {
    log.error("engine failed to start", err);
    showFatal((err as Error).message);
    return;
  }
  createMainWindow();
  scheduleUpdateChecks();
}

// ---------------------------------------------------------------------------
// IPC + updater bridge to the renderer.
// ---------------------------------------------------------------------------
function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function registerIpc(): void {
  ipcMain.on("gm:meta", (e) => {
    e.returnValue = { version: APP_VERSION, build: BUILD_SHA, platform: process.platform };
  });
  // Let these reject so the renderer's invoke() can observe failures in its
  // try/catch. We deliberately resolve with void (the autoUpdater results carry
  // non-cloneable fields like cancellation tokens). Errors still ALSO surface via
  // the 'error' event below, independently.
  ipcMain.handle("gm:check-for-updates", async () => {
    await autoUpdater.checkForUpdates();
  });
  ipcMain.handle("gm:download-update", async () => {
    // On macOS (unsigned) the in-app install can't pass Squirrel's signature
    // check — open the release page for a manual download instead of failing.
    if (MAC_UPDATE_IS_MANUAL) {
      openExternalSafely(RELEASES_LATEST);
      return;
    }
    await autoUpdater.downloadUpdate();
  });
  ipcMain.handle("gm:install-update", () => {
    shuttingDown = true;
    autoUpdater.quitAndInstall();
  });
  ipcMain.handle("gm:open-logs", () => {
    void shell.openPath(path.dirname(log.transports.file.getFile().path));
  });

  autoUpdater.on("update-available", (info) => {
    send("gm:update-available", {
      version: info.version,
      notesUrl: `${NOTES_BASE}/v${info.version}`,
      // macOS can't self-install unsigned — the renderer shows a manual download.
      manual: MAC_UPDATE_IS_MANUAL,
    });
  });
  autoUpdater.on("download-progress", (p) => {
    send("gm:update-progress", {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    send("gm:update-downloaded", { version: info.version, notesUrl: `${NOTES_BASE}/v${info.version}` });
  });
  autoUpdater.on("error", (err) => {
    send("gm:update-error", err == null ? "unknown error" : (err.message ?? String(err)));
  });
}

/** Check on startup and then periodically (every 6h). Disabled in dev. */
function scheduleUpdateChecks(): void {
  if (isDev) {
    log.info("dev build — skipping update checks");
    return;
  }
  const check = () => autoUpdater.checkForUpdates().catch((e) => log.warn("update check failed", e));
  setTimeout(check, 5_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Clean shutdown: never leak the engine process or its port.
// ---------------------------------------------------------------------------
function stopEngine(): void {
  if (!engine) return;
  log.info("stopping engine");
  const child = engine;
  engine = null;
  // Track the real exit — `child.killed` only means a signal was delivered, not
  // that the process is gone, so it can't gate the SIGKILL fallback.
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.kill("SIGTERM");
  // Hard-kill if it's still alive shortly after SIGTERM (hung engine).
  setTimeout(() => {
    if (!exited) child.kill("SIGKILL");
  }, 3000);
}

app.on("before-quit", () => {
  shuttingDown = true;
  stopEngine();
});
app.on("window-all-closed", () => {
  stopEngine();
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", stopEngine);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shuttingDown = true;
    stopEngine();
    app.quit();
  });
}
// macOS: re-create a window when the dock icon is clicked and the engine is up.
app.on("activate", () => {
  if (mainWindow === null && enginePort) createMainWindow();
});
