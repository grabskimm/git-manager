import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type SyncStatus } from "../api";

function relTime(ts?: string): string {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Per-repo backup control: back up just this repo to the configured destinations. */
export function RepoBackup({ repoId }: { repoId: string }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ backend: string; status: string; reason?: string; bytes?: number }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.syncStatus());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    setResults(null);
    void load();
  }, [load, repoId]);

  const enabled = status?.backends.filter((b) => b.enabled) ?? [];
  const lastBackup = status?.manifest?.repos[repoId]?.lastBackupAt;

  const backup = async () => {
    setBusy(true);
    setErr(null);
    setResults(null);
    try {
      const res = await api.syncPush(repoId);
      setResults(res.pushed[0]?.results ?? []);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const allOk = results != null && results.length > 0 && results.every((r) => r.status === "ok");

  if (status && enabled.length === 0) {
    return (
      <div className="repo-backup faint">
        Sync off — <Link to="/settings">configure a destination</Link>
      </div>
    );
  }

  return (
    <div className="repo-backup">
      <div className="row" style={{ gap: 8 }}>
        <button onClick={backup} disabled={busy} title="Sync this repo to all configured destinations">
          {busy ? "Syncing…" : "⟳ Sync"}
        </button>
        {allOk ? (
          <span style={{ fontSize: 12, color: "var(--green)" }}>✓ synced</span>
        ) : (
          <span className="faint" style={{ fontSize: 12 }}>
            {lastBackup ? `last synced ${relTime(lastBackup)}` : "never synced"}
          </span>
        )}
      </div>
      {err && <div className="banner error" style={{ marginTop: 6 }}>{err}</div>}
      {results && !allOk && (
        <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
          {results.map((r, i) => (
            <div key={i}>
              {r.backend}: {r.status}
              {r.status === "ok" ? ` (${((r.bytes ?? 0) / 1024).toFixed(0)} KiB)` : ` — ${r.reason}`}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
