import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

interface Meta {
  version: string;
  build: string | null;
  platform: string;
}

// Synchronous so the version is available to the UI on first paint.
const meta = ipcRenderer.sendSync("gm:meta") as Meta;

/** Subscribe to a main->renderer channel; returns an unsubscribe function. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// Exposed as window.__GM_DESKTOP__ — see packages/ui/src/desktop.ts for the
// matching interface. Only these explicit functions cross the bridge; the
// renderer never gets ipcRenderer or Node directly.
contextBridge.exposeInMainWorld("__GM_DESKTOP__", {
  isDesktop: true,
  version: meta.version,
  build: meta.build,
  platform: meta.platform,

  checkForUpdates: () => ipcRenderer.invoke("gm:check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("gm:download-update"),
  installUpdate: () => ipcRenderer.invoke("gm:install-update"),
  openLogsFolder: () => ipcRenderer.invoke("gm:open-logs"),

  onUpdateAvailable: (cb: (info: unknown) => void) => on("gm:update-available", cb),
  onUpdateProgress: (cb: (p: unknown) => void) => on("gm:update-progress", cb),
  onUpdateDownloaded: (cb: (info: unknown) => void) => on("gm:update-downloaded", cb),
  onUpdateError: (cb: (msg: string) => void) => on("gm:update-error", cb),
});
