import { useEffect, useState } from "react";
import { desktop, type DesktopUpdateInfo } from "../desktop";

type Phase = "idle" | "available" | "downloading" | "downloaded" | "error";

const DISMISS_KEY = "gm_update_dismissed";

/** Remember a "Later" dismissal per-version so we don't nag on every focus. */
function isDismissed(version: string): boolean {
  return localStorage.getItem(DISMISS_KEY) === version;
}
function dismiss(version: string): void {
  localStorage.setItem(DISMISS_KEY, version);
}

/**
 * Non-blocking upgrade prompt rendered near the sidebar. Wired to the desktop
 * shell's updater events so the look-and-feel matches GitManager instead of the
 * default OS dialog. Renders nothing in the browser/CLI build.
 */
export function UpdateBanner() {
  const d = desktop();
  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<DesktopUpdateInfo | null>(null);
  const [percent, setPercent] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!d) return;
    const offs = [
      d.onUpdateAvailable((i) => {
        setInfo(i);
        setErrorMsg(null);
        // Respect a prior "Later" for this exact version.
        setPhase(isDismissed(i.version) ? "idle" : "available");
      }),
      d.onUpdateProgress((p) => {
        setPhase("downloading");
        setPercent(Math.round(p.percent));
      }),
      d.onUpdateDownloaded((i) => {
        setInfo(i);
        setPhase("downloaded");
      }),
      d.onUpdateError((m) => {
        setErrorMsg(m);
        setPhase("error");
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [d]);

  if (!d || phase === "idle") return null;

  // The error phase carries no update info (e.g. a check fails before any
  // update is discovered), so render it independently of `info`.
  if (phase === "error") {
    return (
      <div className="banner info update-banner" role="status">
        <div className="update-banner-text">
          Update failed{errorMsg ? `: ${errorMsg}` : ""}.
        </div>
        <div className="update-banner-actions">
          <button className="primary" onClick={() => void d.checkForUpdates()}>
            Retry
          </button>
          <button className="ghost" onClick={() => setPhase("idle")}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // The remaining phases (available / downloading / downloaded) all need info.
  if (!info) return null;

  const later = () => {
    dismiss(info.version);
    setPhase("idle");
  };

  return (
    <div className="banner info update-banner" role="status">
      {phase === "available" && (
        <>
          <div className="update-banner-text">
            <strong>Update available</strong> — v{info.version}
            {info.notesUrl && (
              <>
                {" · "}
                <a href={info.notesUrl} target="_blank" rel="noreferrer">
                  release notes
                </a>
              </>
            )}
          </div>
          <div className="update-banner-actions">
            <button className="primary" onClick={() => void d.downloadUpdate()}>
              Update now
            </button>
            <button className="ghost" onClick={later}>
              Later
            </button>
          </div>
        </>
      )}

      {phase === "downloading" && (
        <div className="update-banner-text">
          Downloading v{info.version}… {percent}%
          <div className="update-progress">
            <div className="update-progress-bar" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}

      {phase === "downloaded" && (
        <>
          <div className="update-banner-text">
            <strong>v{info.version} is ready.</strong> Relaunch to finish updating.
          </div>
          <div className="update-banner-actions">
            <button className="primary" onClick={() => void d.installUpdate()}>
              Relaunch
            </button>
            <button className="ghost" onClick={later}>
              Later
            </button>
          </div>
        </>
      )}
    </div>
  );
}
