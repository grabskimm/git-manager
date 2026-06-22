import { useState } from "react";
import { api } from "../api";
import { useApp } from "../state";
import { BackupSettings } from "../components/BackupSettings";
import { AboutSettings } from "../components/AboutSettings";

type Tab = "sources" | "features" | "backup" | "security" | "about";

const TABS: { id: Tab; label: string }[] = [
  { id: "sources", label: "Sources" },
  { id: "features", label: "Features" },
  { id: "backup", label: "Backup & sync" },
  { id: "security", label: "Security" },
  { id: "about", label: "About" },
];

export function Settings() {
  const { sourceDirs, config, reloadSourceDirs, reloadRepos, setConfig } = useApp();
  const [tab, setTab] = useState<Tab>("sources");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    if (!path.trim()) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await api.addSourceDir(path.trim());
      const clonedNote = res.cloned ? ` Cloned into ${res.cloned}.` : "";
      setMsg(`Added. Found ${res.scanned} repositor${res.scanned === 1 ? "y" : "ies"}.${clonedNote}`);
      setPath("");
      await Promise.all([reloadSourceDirs(), reloadRepos()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await api.removeSourceDir(id);
    await reloadSourceDirs();
  };

  return (
    <div className="page">
      <h1>Settings</h1>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "sources" && (
        <>
          <h2>Source directories</h2>
          <p className="subtle">
            GitManager recursively scans these directories for git repositories. Enter a local
            path — Linux/macOS (<code>/home/you/projects</code>, <code>~/code</code>) or Windows
            (<code>C:\Users\you\projects</code>) — or an <code>https</code>/<code>git</code> URL to
            clone a repo locally (the local <code>.git</code> stays canonical).
          </p>
          <div className="row" style={{ marginBottom: 10 }}>
            <input
              placeholder="~/projects  ·  C:\\Users\\you\\code  ·  https://host/user/repo.git"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button className="primary" onClick={add} disabled={busy}>
              {busy ? "Scanning…" : "Add & scan"}
            </button>
          </div>
          {msg && <div className="banner info">{msg}</div>}
          {err && <div className="banner error">{err}</div>}

          {sourceDirs.length === 0 ? (
            <div className="empty subtle">No source directories yet.</div>
          ) : (
            <div className="list">
              {sourceDirs.map((d) => (
                <div key={d.id} className="list-row" style={{ cursor: "default" }}>
                  <span className="mono">{d.path}</span>
                  <span className="spacer" />
                  <button className="danger" onClick={() => remove(d.id)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "features" && config && (
        <>
          <h2>Pull requests &amp; review</h2>
          <div className="stack">
            <label className="toggle">
              <input
                type="checkbox"
                checked={config.review_on_pr_open}
                onChange={(e) => setConfig({ review_on_pr_open: e.target.checked })}
              />
              <span>
                Run Claude review automatically when a PR is opened
                <div className="faint" style={{ fontSize: 12 }}>
                  Uses your existing <code>claude</code> login. Skips gracefully if absent.
                </div>
              </span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={config.delete_head_on_merge}
                onChange={(e) => setConfig({ delete_head_on_merge: e.target.checked })}
              />
              <span>Delete the head branch after a successful merge</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={config.implement_enabled}
                onChange={(e) => setConfig({ implement_enabled: e.target.checked })}
              />
              <span>
                Allow Claude to implement PR changes (opt-in)
                <div className="faint" style={{ fontSize: 12 }}>
                  Adds an <strong>Implement</strong> action on PR reviews. Claude edits files in a
                  throwaway worktree and commits to the head branch — your checkout is untouched.
                  This lets <code>claude</code> <strong>write files in your repo</strong> with your
                  credentials; leave off unless you want that.
                </div>
              </span>
            </label>
          </div>

          <hr className="sep" />
          <h2>Panels &amp; tools</h2>
          <div className="stack">
            <label className="toggle">
              <input
                type="checkbox"
                checked={config.agent_observe_enabled}
                onChange={(e) => setConfig({ agent_observe_enabled: e.target.checked })}
              />
              <span>
                Enable the agent observe panel (opt-in)
                <div className="faint" style={{ fontSize: 12 }}>
                  Reads Claude Code, Antigravity, Copilot CLI and other session transcripts
                  read-only and binds them to repos/PRs.
                </div>
              </span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={config.chat_enabled}
                onChange={(e) => setConfig({ chat_enabled: e.target.checked })}
              />
              <span>
                Enable repo chat
                <div className="faint" style={{ fontSize: 12 }}>
                  Chat panel in the right sidebar talks to your <code>claude</code> about repos in
                  your source list (read-only metadata). Skips gracefully if <code>claude</code>{" "}
                  isn't installed.
                </div>
              </span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={config.terminal_enabled}
                onChange={(e) => setConfig({ terminal_enabled: e.target.checked })}
              />
              <span>
                Enable built-in terminal (opt-in)
                <div className="faint" style={{ fontSize: 12 }}>
                  Adds a Terminal tab to each repo view. Opens a real shell (<code>$SHELL</code>)
                  already <code>cd</code>'d into the repo directory.
                </div>
              </span>
            </label>
          </div>
        </>
      )}

      {tab === "backup" && <BackupSettings />}

      {tab === "about" && <AboutSettings />}

      {tab === "security" && (
        <>
          <h2>Security</h2>
          <p className="subtle">
            The engine binds <code>127.0.0.1</code> only and requires a local token (stored at{" "}
            <code>~/.gitmanager/token</code>, mode 0600) plus an Origin check on every request.
          </p>
          <ul className="subtle" style={{ lineHeight: 1.8 }}>
            <li>Loopback-only bind — never <code>0.0.0.0</code>.</li>
            <li>
              Bearer token on every <code>/api</code> call; the WebSocket upgrade
              carries the same token via <code>Sec-WebSocket-Protocol</code>;
              constant-time comparison.
            </li>
            <li>Origin allow-list (blocks DNS-rebinding / CSRF) on state-changing requests.</li>
            <li>
              No telemetry. Network calls happen only when you opt into remote PRs or backup, and
              only to the provider you configured.
            </li>
          </ul>
        </>
      )}
    </div>
  );
}
