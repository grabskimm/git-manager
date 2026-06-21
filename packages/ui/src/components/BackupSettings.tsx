import { useCallback, useEffect, useState } from "react";
import { api, type SyncStatus, type SyncPushRepo } from "../api";
import { useApp } from "../state";

type ProviderId = "fs" | "s3" | "r2" | "azure";

interface FieldDef {
  key: string;
  label: string;
  required: boolean;
  placeholder?: string;
}
interface ProviderDef {
  id: ProviderId;
  label: string;
  auth: string;
  fields: FieldDef[];
}

const DEFAULT_FS_DIR = "~/.gitmanager/backups";

const PROVIDERS: ProviderDef[] = [
  {
    id: "fs",
    label: "Local folder / NAS",
    auth: "Writes to a local path — no login required.",
    fields: [
      { key: "dir", label: "Directory", required: true, placeholder: "~/.gitmanager/backups" },
      { key: "prefix", label: "Prefix", required: false, placeholder: "gitmanager" },
    ],
  },
  {
    id: "s3",
    label: "AWS S3 (or S3-compatible)",
    auth: "Uses your AWS login (default credential chain / `aws sso login`).",
    fields: [
      { key: "bucket", label: "Bucket", required: true, placeholder: "my-bucket" },
      { key: "region", label: "Region", required: false, placeholder: "us-east-1" },
      { key: "endpoint", label: "Endpoint (S3-compatible only)", required: false, placeholder: "https://…" },
      { key: "prefix", label: "Prefix", required: false, placeholder: "gitmanager" },
    ],
  },
  {
    id: "r2",
    label: "Cloudflare R2",
    auth: "Uses `wrangler login` (or `npx wrangler`) — no access keys stored.",
    fields: [
      { key: "bucket", label: "R2 bucket", required: true, placeholder: "my-r2-bucket" },
      { key: "prefix", label: "Prefix", required: false, placeholder: "gitmanager" },
    ],
  },
  {
    id: "azure",
    label: "Azure Blob Storage",
    auth: "Uses `az login` (DefaultAzureCredential).",
    fields: [
      { key: "account", label: "Storage account", required: true, placeholder: "myaccount" },
      { key: "container", label: "Container", required: true, placeholder: "gitmanager" },
      { key: "prefix", label: "Prefix", required: false, placeholder: "" },
    ],
  },
];

type Entry = { enabled: boolean; values: Record<string, string> };
type FormState = Record<ProviderId, Entry>;

function emptyForm(): FormState {
  return {
    fs: { enabled: false, values: {} },
    s3: { enabled: false, values: {} },
    r2: { enabled: false, values: {} },
    azure: { enabled: false, values: {} },
  };
}

function formFromBackends(backends: Record<string, unknown>[]): FormState {
  const form = emptyForm();
  for (const b of backends) {
    const id = b.id as ProviderId;
    if (!form[id]) continue;
    const values: Record<string, string> = {};
    for (const f of PROVIDERS.find((p) => p.id === id)!.fields) {
      const v = b[f.key];
      if (typeof v === "string") values[f.key] = v;
    }
    form[id] = { enabled: Boolean(b.enabled), values };
  }
  return form;
}

function backendsFromForm(form: FormState): { backends: Record<string, unknown>[] } {
  const backends: Record<string, unknown>[] = [];
  for (const p of PROVIDERS) {
    const e = form[p.id];
    const hasData = Object.values(e.values).some((v) => v?.trim());
    if (!e.enabled && !hasData) continue; // keep config only if used/filled
    const entry: Record<string, unknown> = { id: p.id, enabled: e.enabled };
    for (const f of p.fields) {
      const v = e.values[f.key]?.trim();
      if (v) entry[f.key] = v;
    }
    backends.push(entry);
  }
  return { backends };
}

export function BackupSettings() {
  const { config, setConfig } = useApp();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [status, setStatus] = useState<SyncStatus | null>(null);
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
      .then((c) => setForm(formFromBackends((c.backends as Record<string, unknown>[]) ?? [])))
      .catch(() => setForm(emptyForm()));
    void reload();
  }, [reload]);

  const setEnabled = (id: ProviderId, enabled: boolean) =>
    setForm((f) => {
      const entry = { ...f[id], enabled };
      // Prefill the local-folder default the first time it's enabled.
      if (id === "fs" && enabled && !entry.values.dir?.trim()) {
        entry.values = { ...entry.values, dir: DEFAULT_FS_DIR };
      }
      return { ...f, [id]: entry };
    });
  const setValue = (id: ProviderId, key: string, value: string) =>
    setForm((f) => ({ ...f, [id]: { ...f[id], values: { ...f[id].values, [key]: value } } }));

  const save = async () => {
    setErr(null);
    setMsg(null);
    // Validate required fields for enabled providers.
    for (const p of PROVIDERS) {
      if (!form[p.id].enabled) continue;
      for (const field of p.fields) {
        if (field.required && !form[p.id].values[field.key]?.trim()) {
          setErr(`${p.label}: “${field.label}” is required.`);
          return;
        }
      }
    }
    setBusy(true);
    try {
      await api.setSyncConfig(backendsFromForm(form));
      setMsg("Saved backup destinations.");
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
      setPushed((await api.syncPush()).pushed);
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const readyById = (id: string) => status?.backends.find((b) => b.id === id)?.ready;

  if (!config) return null;

  return (
    <>
      <h2>Backup &amp; sync</h2>
      <p className="subtle">
        Back up each repo as a <code>git bundle</code> to object storage (S3, Cloudflare R2, Azure,
        or a local folder) so you can move between devices without GitHub. Git stays{" "}
        <strong>local</strong>; storage only holds backups. Credentials come from your provider
        logins — <strong>no keys are stored here</strong>.
      </p>

      <h3 style={{ fontSize: 14, margin: "16px 0 8px" }}>Backup destinations</h3>
      <p className="subtle" style={{ fontSize: 13 }}>
        Tick the providers you want, then fill in their fields. Multiple destinations are written on
        every backup.
      </p>

      <div className="stack">
        {PROVIDERS.map((p) => {
          const e = form[p.id];
          const ready = readyById(p.id);
          return (
            <div key={p.id} className="card" style={{ padding: 12 }}>
              <label className="toggle" style={{ alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={e.enabled}
                  onChange={(ev) => setEnabled(p.id, ev.target.checked)}
                />
                <span>
                  <strong>{p.label}</strong>
                  {e.enabled && ready && (
                    <span
                      className="ref"
                      style={{
                        marginLeft: 8,
                        color: ready.ok ? "var(--green)" : "var(--red)",
                        borderColor: ready.ok ? "var(--green)" : "var(--red)",
                      }}
                    >
                      {ready.ok ? "ready" : "not ready"}
                    </span>
                  )}
                  <div className="faint" style={{ fontSize: 12 }}>
                    {p.auth}
                  </div>
                </span>
              </label>

              {e.enabled && (
                <div className="stack" style={{ marginTop: 10, paddingLeft: 26 }}>
                  {p.fields.map((f) => (
                    <div key={f.key} className="row" style={{ gap: 8 }}>
                      <span className="faint" style={{ width: 180, fontSize: 13 }}>
                        {f.label}
                        {f.required && <span style={{ color: "var(--red)" }}> *</span>}
                      </span>
                      <input
                        value={e.values[f.key] ?? ""}
                        placeholder={f.placeholder}
                        onChange={(ev) => setValue(p.id, f.key, ev.target.value)}
                      />
                    </div>
                  ))}
                  {e.enabled && ready && !ready.ok && (
                    <div className="faint" style={{ fontSize: 12, color: "var(--red)" }}>
                      {ready.reason}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={save} disabled={busy}>
          Save destinations
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

      <hr className="sep" />
      <h3 style={{ fontSize: 14, margin: "8px 0" }}>Schedule</h3>
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
              Push every tracked repo to all enabled destinations on an interval. Off = manual only.
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

      {status?.manifest && (
        <div className="faint" style={{ fontSize: 12, marginTop: 12 }}>
          {Object.keys(status.manifest.repos).length} repo(s) backed up · manifest from{" "}
          {status.manifestFrom} · updated {new Date(status.manifest.updatedAt).toLocaleString()}
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
