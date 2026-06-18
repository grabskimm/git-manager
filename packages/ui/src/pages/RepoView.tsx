import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../state";
import { DiffViewer } from "../components/DiffViewer";
import { StatusBadge } from "../components/StatusBadge";
import type { Branch, Commit, DiffResponse, Pr, Repo } from "../types";

export function RepoView() {
  const { repoId = "" } = useParams();
  const navigate = useNavigate();
  const { onWs } = useApp();

  const [repo, setRepo] = useState<Repo | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [prs, setPrs] = useState<Pr[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.getRepo(repoId);
      setRepo(r);
      const b = await api.branches(repoId);
      setBranches(b);
      setPrs(await api.listPrs(repoId));
      const defBranch = r.default_branch ?? b[0]?.name ?? "";
      const other = b.find((x) => x.name !== defBranch)?.name ?? defBranch;
      setBase((prev) => prev || defBranch);
      setHead((prev) => prev || other);
      setCommits(await api.commits(repoId, other || defBranch));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [repoId]);

  useEffect(() => {
    setRepo(null);
    setDiff(null);
    setBase("");
    setHead("");
    void load();
  }, [load]);

  useEffect(() => {
    return onWs((e) => {
      if (e.type === "pr.updated" || e.type === "pr.created") {
        void api.listPrs(repoId).then(setPrs);
      }
    });
  }, [onWs, repoId]);

  const viewDiff = async () => {
    if (!base || !head) return;
    setError(null);
    try {
      setDiff(await api.diff(repoId, base, head));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const createPr = async () => {
    if (!title.trim() || !base || !head || base === head) {
      setError("Title required, and base/head must differ.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pr = await api.createPr({
        repo_id: repoId,
        title: title.trim(),
        description: description.trim() || undefined,
        base_ref: base,
        head_ref: head,
      });
      navigate(`/prs/${pr.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!repo) {
    return (
      <div className="page">
        {error ? <div className="banner error">{error}</div> : <p className="subtle">Loading…</p>}
      </div>
    );
  }

  const openPrs = prs.filter((p) => p.status === "open" || p.status === "conflicted");
  const closedPrs = prs.filter((p) => p.status === "merged" || p.status === "closed");

  return (
    <div className="page">
      <div className="spread">
        <div>
          <h1>{repo.display_name}</h1>
          <div className="mono faint" style={{ fontSize: 12 }}>
            {repo.abs_path}
          </div>
        </div>
        <span className="ref">{repo.default_branch ?? "—"}</span>
      </div>

      {error && <div className="banner error">{error}</div>}

      <h2>Compare & open a PR</h2>
      <div className="card stack">
        <div className="row wrap">
          <span className="faint">base</span>
          <select value={base} onChange={(e) => setBase(e.target.value)} style={{ width: 180 }}>
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
          <span className="faint">←</span>
          <select
            value={head}
            onChange={(e) => {
              setHead(e.target.value);
              void api.commits(repoId, e.target.value).then(setCommits);
            }}
            style={{ width: 180 }}
          >
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
          <button onClick={viewDiff}>View diff</button>
          <span className="spacer" />
        </div>
        <input placeholder="PR title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea
          placeholder="Description (optional)"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="row">
          <button className="primary" onClick={createPr} disabled={busy}>
            {busy ? "Opening…" : "Open pull request"}
          </button>
          <span className="faint">
            Opening a PR triggers an automatic Claude review of the diff.
          </span>
        </div>
      </div>

      {diff && <DiffViewer diff={diff.diff} stat={diff.stat} />}

      <h2>Pull requests</h2>
      {prs.length === 0 ? (
        <div className="banner info">No pull requests yet for this repo.</div>
      ) : (
        <div className="list">
          {[...openPrs, ...closedPrs].map((p) => (
            <Link key={p.id} to={`/prs/${p.id}`} className="list-row">
              <StatusBadge status={p.status} />
              <strong>{p.title}</strong>
              <span className="ref">{p.head_ref}</span>
              <span className="faint">→</span>
              <span className="ref">{p.base_ref}</span>
            </Link>
          ))}
        </div>
      )}

      <h2>Recent commits — {head}</h2>
      <div className="list">
        {commits.slice(0, 15).map((c) => (
          <div key={c.sha} className="list-row" style={{ cursor: "default" }}>
            <span className="sha">{c.shortSha}</span>
            <span>{c.subject}</span>
            <span className="spacer" />
            <span className="faint" style={{ fontSize: 12 }}>
              {c.author}
            </span>
          </div>
        ))}
        {commits.length === 0 && <div className="list-row faint">No commits.</div>}
      </div>
    </div>
  );
}
