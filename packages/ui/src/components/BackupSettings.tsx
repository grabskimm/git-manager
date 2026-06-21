import { useCallback, useEffect, useState } from "react";
import { api, type SyncStatus, type SyncPushRepo } from "../api";
import { useApp } from "../state";

const EXAMPLE = {
  backends: [
    { id: "fs", enabled: true, dir: "~/gitmanager-backups", prefix: "gitmanager" },
    { id: "s3", enabled: false, bucket: "my-bucket", region: "us-east-1", prefix: "gitmanager" },
    { id: "r2", enabled: false, bucket: "my-r2-bucket", prefix: "gitmanager" },
    { id: "azure", enabled: false, account: "myacct", container: "gitmanager", prefix: "" },
  ],
};

export function BackupSettings() {
  const { config, setConfig } = useApp();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [json, setJson] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushed, setPushed] = useState<SyncPushRepo[] | null>(null);

  const reload = useCallback(async () => {
    try {
      setStatus(await api.syncStatus());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void api
      .getSyncConfig()
      .then((c) => setJson(JSON.stringify(c.backends?.length ? c : EXAMPLE, null, 2)))
      .catch(() => setJson(JSON.stringify(EXAMPLE, null, 2)));
    void reload();
  }, [reload]);

  const saveConfig = async () => {
    setErr(null);
    setMsg(null);
    let parsed: { backends: unknown[] };
    try {
      parsed = JSON.parse(json);
      if (!Array.isArray(parsed.backends)) throw new Error("`backends` must be an array");
    } catch (e) {
      setErr(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    setBusy(true);
    try {
      await api.setSyncConfig(parsed);
      setMsg("Saved storage config.");
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pushNow = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    setPushed(null);
    try {
      const res = await api.syncPush();
      setPushed(res.pushed);
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!config) return null;

  return (
    <>
      <hr className="sep" />
      <h2>Backup &amp; sync</h2>
      <p className="subtle">
        Back up each repo as a <code>git bundle</code> to object storage (S3, Cloudflare R2, Azure,
        or a local folder) so you can move between devices without GitHub. Git stays{" "}
        <strong>local</strong>; storage only holds backups. Credentials come from your provider
        logins (<code>aws sso login</code>, <code>wrangler login</code>, <code>az login</code>) —
        no keys are stored here.
      </p>

      <div className="stack">
        <label className="toggle">
          <input
            type="checkbox"
            checked={config.sync_enabled}
            onChange={(e) => setConfig({ sync_enabled: e.target.checked })}
          />
          <span>
            Scheduled backup (opt-in)
            <div className="faint" style={{ fontSize: 12 }}>
              Push every tracked repo to all enabled backends on an interval. Off = manual only.
            </div>
          </span>
        </label>
        <div className="row">
          <span className="faint">every</span>
          <input
            type="number"
            min={1}
            max={1440}
            value={config.sync_interval_minutes}
            onChange={(e) => setConfig({ sync_interval_minutes: Number(e.target.value) })}
            style={{ width: 90 }}
            disabled={!config.sync_enabled}
          />
          <span className="faint">minutes</span>
        </div>
      </div>

      <h3 style={{ fontSize: 14, margin: "16px 0 6px" }}>Backends</h3>
      <p className="subtle" style={{ fontSize: 13 }}>
        Configure one or more targets. <code>id</code> is one of <code>fs</code>, <code>s3</code>,{" "}
        <code>r2</code>, <code>azure</code>. Multiple enabled backends are written to on every push.
      </p>
      <textarea
        rows={10}
        className="mono"
        value={json}
        onChange={(e) => setJson(e.target.value)}
        style={{ fontSize: 12 }}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={saveConfig} disabled={busy}>
          Save backends
        </button>
        <button onClick={pushNow} disabled={busy}>
          {busy ? "Backing up…" : "Back up all now"}
        </button>
        <button onClick={() => void reload()} disabled={busy}>
          Refresh status
        </button>
      </div>

      {msg && <div className="banner info" style={{ marginTop: 8 }}>{msg}</div>}
      {err && <div className="banner error" style={{ marginTop: 8 }}>{err}</div>}

      {status && (
        <div style={{ marginTop: 12 }}>
          {status.backends.length === 0 && (
            <div className="faint">No backends configured yet.</div>
          )}
          {status.backends.map((b) => (
            <div key={b.id} className="row" style={{ fontSize: 13, gap: 8 }}>
              <span
                className="dotmark"
                style={{ color: !b.enabled ? "var(--fg-faint)" : b.ready.ok ? "var(--green)" : "var(--red)" }}
              />
              <span className="mono">{b.label}</span>
              <span className="faint">
                {!b.enabled ? "disabled" : b.ready.ok ? "ready" : b.ready.reason}
              </span>
            </div>
          ))}
          {status.manifest && (
            <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
              {Object.keys(status.manifest.repos).length} repo(s) backed up · manifest from{" "}
              {status.manifestFrom} · updated {new Date(status.manifest.updatedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {pushed && (
        <div className="list" style={{ marginTop: 10 }}>
          {pushed.map((p) => (
            <div key={p.gmId} className="list-row" style={{ cursor: "default", display: "block" }}>
              <strong>{p.repo}</strong>
              {p.results.map((r, i) => (
                <div key={i} className="faint" style={{ fontSize: 12 }}>
                  {r.backend}: {r.status}
                  {r.status === "ok" ? ` (${((r.bytes ?? 0) / 1024).toFixed(0)} KiB)` : ` — ${r.reason}`}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
