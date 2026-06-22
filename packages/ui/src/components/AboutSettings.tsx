import { useEffect, useState } from "react";
import { desktop, type DesktopUpdateInfo } from "../desktop";
import { useVersion } from "./AppVersion";

// Single source for the repo links surfaced in the UI.
const REPO_URL = "https://github.com/grabskimm/git-manager";
const RELEASES_URL = `${REPO_URL}/releases`;

type Phase = "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";

/**
 * "About" settings: source-code link, the running version, and an upgrade
 * affordance. In the desktop app this drives the in-app updater (check / update /
 * relaunch); in the browser/CLI build it shows the version and links out to
 * releases, since the web build can't self-update.
 */
export function AboutSettings() {
  const info = useVersion();
  const d = desktop();
  const [phase, setPhase] = useState<Phase>("idle");
  const [update, setUpdate] = useState<DesktopUpdateInfo | null>(null);
  const [percent, setPercent] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!d) return;
    const offs = [
      d.onUpdateAvailable((i) => {
        setUpdate(i);
        setNote(null);
        setPhase("available");
      }),
      d.onUpdateProgress((p) => {
        setPercent(Math.round(p.percent));
        setPhase("downloading");
      }),
      d.onUpdateDownloaded((i) => {
        setUpdate(i);
        setPhase("downloaded");
      }),
      d.onUpdateError((m) => {
        setNote(m);
        setPhase("error");
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [d]);

  const check = async () => {
    if (!d) return;
    setUpdate(null); // drop any stale "available" result from a prior check
    setNote(null);
    setPhase("checking");
    try {
      await d.checkForUpdates();
      // An update-available/error event may have already flipped the phase. Only
      // declare "latest" if we're still "checking" — and set the note inside the
      // same guard so it can't contradict a banner that arrived first.
      setPhase((p) => {
        if (p === "checking") {
          setNote("You're on the latest version.");
          return "idle";
        }
        return p;
      });
    } catch (e) {
      setPhase("error");
      setNote(e instanceof Error ? e.message : "Update check failed.");
    }
  };

  const versionLabel = info
    ? `v${info.version}${info.build ? ` (build ${info.build})` : ""}`
    : "…";

  return (
    <>
      <h2>About GitManager</h2>
      <div className="about-list">
        <div className="about-row">
          <span className="about-label">Version</span>
          <span className="mono">{versionLabel}</span>
        </div>
        <div className="about-row">
          <span className="about-label">Source code</span>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            github.com/grabskimm/git-manager
          </a>
        </div>
        <div className="about-row">
          <span className="about-label">Releases &amp; changelog</span>
          <a href={RELEASES_URL} target="_blank" rel="noreferrer">
            View releases
          </a>
        </div>
      </div>

      <hr className="sep" />
      <h2>Updates</h2>

      {d ? (
        <div className="stack">
          {phase === "available" && update && (
            <div className="banner info">
              <div>
                Update available — <strong>v{update.version}</strong>
                {update.notesUrl && (
                  <>
                    {" · "}
                    <a href={update.notesUrl} target="_blank" rel="noreferrer">
                      release notes
                    </a>
                  </>
                )}
              </div>
              <div className="update-banner-actions" style={{ marginTop: 8 }}>
                <button className="primary" onClick={() => void d.downloadUpdate()}>
                  Update now
                </button>
              </div>
            </div>
          )}

          {phase === "downloading" && update && (
            <div className="banner info">
              {update.manual ? (
                "Installing update…"
              ) : (
                <>
                  Downloading v{update.version}… {percent}%
                  <div className="update-progress">
                    <div className="update-progress-bar" style={{ width: `${percent}%` }} />
                  </div>
                </>
              )}
            </div>
          )}

          {phase === "downloaded" && update && (
            <div className="banner info">
              <div>
                <strong>v{update.version} is ready.</strong> Relaunch to finish updating.
              </div>
              <div className="update-banner-actions" style={{ marginTop: 8 }}>
                <button className="primary" onClick={() => void d.installUpdate()}>
                  Relaunch
                </button>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="banner error">Update check failed{note ? `: ${note}` : ""}.</div>
          )}

          {(phase === "idle" || phase === "checking" || phase === "error") && (
            <>
              <p className="subtle">
                {note ?? "The desktop app checks for updates automatically on launch and periodically."}
              </p>
              <div className="row">
                <button className="primary" onClick={check} disabled={phase === "checking"}>
                  {phase === "checking" ? "Checking…" : "Check for updates"}
                </button>
                <button className="ghost" onClick={() => void d.openLogsFolder()}>
                  Open logs folder
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <p className="subtle">
          You're running GitManager in the browser. The{" "}
          <a href={RELEASES_URL} target="_blank" rel="noreferrer">
            desktop app
          </a>{" "}
          auto-updates; to upgrade a web/CLI install, pull the latest from{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            the repository
          </a>{" "}
          and rebuild. Compare your version above against the{" "}
          <a href={RELEASES_URL} target="_blank" rel="noreferrer">
            latest release
          </a>
          .
        </p>
      )}
    </>
  );
}
