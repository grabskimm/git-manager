import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../state";

/**
 * Modal to create a brand-new local git repository. The engine runs
 * `git init` under the chosen parent directory, registers that parent as a
 * source dir, and scans so the repo appears immediately.
 */
export function NewRepoDialog({ onClose }: { onClose: () => void }) {
  const { reloadRepos, reloadSourceDirs } = useApp();
  const navigate = useNavigate();
  const [parent, setParent] = useState("~/projects");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async () => {
    if (!name.trim() || !parent.trim()) {
      setErr("Both a parent directory and a name are required.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await api.createRepo(parent.trim(), name.trim());
      await Promise.all([reloadRepos(), reloadSourceDirs()]);
      onClose();
      if (res.repo) navigate(`/repos/${res.repo.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 style={{ margin: 0, fontSize: 16 }}>New repository</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <p className="subtle" style={{ fontSize: 13, marginTop: 0 }}>
          Creates an empty git repo (with a starter <code>README.md</code> and an initial commit)
          and starts tracking it.
        </p>

        <div className="stack" style={{ gap: 12 }}>
          <label className="field">
            <span className="field-label">Name</span>
            <input
              ref={nameRef}
              placeholder="my-project"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
          </label>
          <label className="field">
            <span className="field-label">Parent directory</span>
            <input
              placeholder="~/projects"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
          </label>
          {name.trim() && parent.trim() && (
            <div className="faint mono" style={{ fontSize: 12 }}>
              → {parent.replace(/\/$/, "")}/{name.trim()}
            </div>
          )}
        </div>

        {err && <div className="banner error" style={{ marginTop: 12 }}>{err}</div>}

        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create repository"}
          </button>
        </div>
      </div>
    </div>
  );
}
