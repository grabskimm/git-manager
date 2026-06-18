import { useState } from "react";
import { api } from "../api";
import { useApp } from "../state";

export function Settings() {
  const { sourceDirs, config, reloadSourceDirs, reloadRepos, setConfig } = useApp();
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
      setMsg(`Added. Found ${res.scanned} repositor${res.scanned === 1 ? "y" : "ies"}.`);
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

      <h2>Source directories</h2>
      <p className="subtle">
        GitManager recursively scans these directories for git repositories. Paths are
        machine-local; repo identity is derived from the root commit (§8).
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        <input
          placeholder="/absolute/path/to/projects"
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

      <hr className="sep" />
      <h2>Behavior</h2>
      {config && (
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
              checked={config.agent_observe_enabled}
              onChange={(e) => setConfig({ agent_observe_enabled: e.target.checked })}
            />
            <span>
              Enable the agent observe panel (opt-in)
              <div className="faint" style={{ fontSize: 12 }}>
                Reads Claude Code session transcripts read-only and binds them to repos/PRs.
              </div>
            </span>
          </label>
        </div>
      )}

      <hr className="sep" />
      <h2>Security</h2>
      <p className="subtle">
        The engine binds <code>127.0.0.1</code> only and requires a local token (stored at{" "}
        <code>~/.gitmanager/token</code>, mode 0600) plus an Origin check on every request.
      </p>
    </div>
  );
}
