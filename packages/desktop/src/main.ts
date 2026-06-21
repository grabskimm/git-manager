import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
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
    return require.resolve("@gitmanager/engine/dist/cli.js");
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
    backgroundColor: "#0d1117",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#0d1117;color:#c9d1d9;
    font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;
    justify-content:center;flex-direction:column;gap:14px}
  .b{font-size:22px;font-weight:700}.b .d{color:#3fb950}
  .s{font-size:13px;color:#8b949e}
  .spin{width:22px;height:22px;border:3px solid #30363d;border-top-color:#3fb950;
    border-radius:50%;animation:r .8s linear infinite}
  @keyframes r{to{transform:rotate(360deg)}}
</style></head><body>
  <div class="b">Git<span class="d">&#9679;</span>Manager</div>
  <div class="spin"></div>
  <div class="s">Starting local engine&hellip;</div>
</body></html>`;
  void splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function showFatal(message: string): void {
  const win = mainWindow ?? splashWindow;
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#0d1117;color:#c9d1d9;
  font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
  flex-direction:column;gap:12px;padding:24px;text-align:center}
  h1{color:#f85149;font-size:18px;margin:0}p{color:#8b949e;max-width:34rem}</style>
</head><body><h1>GitManager could not start</h1><p>${message}</p>
<p>See the logs for details (Help &rarr; Open logs folder).</p></body></html>`;
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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer only ever loads our own loopback origin; keep it hardened.
      webSecurity: true,
    },
  });

  // Lock the webview down: no new windows, no navigation off the loopback origin.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url); // links (release notes etc.) open in the browser
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://${HOST}:${enginePort}`)) {
      e.preventDefault();
      void shell.openExternal(url);
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
  ipcMain.handle("gm:check-for-updates", () => autoUpdater.checkForUpdates().catch(noop));
  ipcMain.handle("gm:download-update", () => autoUpdater.downloadUpdate().catch(noop));
  ipcMain.handle("gm:install-update", () => {
    shuttingDown = true;
    autoUpdater.quitAndInstall();
  });
  ipcMain.handle("gm:open-logs", () => {
    void shell.openPath(path.dirname(log.transports.file.getFile().path));
  });

  autoUpdater.on("update-available", (info) => {
    send("gm:update-available", { version: info.version, notesUrl: `${NOTES_BASE}/v${info.version}` });
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
  child.kill("SIGTERM");
  // Hard-kill if it hasn't exited shortly after SIGTERM.
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
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

function noop(): void {
  /* swallow — errors surface via the autoUpdater 'error' event */
}
