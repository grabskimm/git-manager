import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../state";
import { DiffViewer } from "../components/DiffViewer";
import { StatusBadge } from "../components/StatusBadge";
import { FileBrowser } from "../components/FileBrowser";
import { Terminal } from "../components/Terminal";
import type { Branch, Commit, DiffResponse, Pr, Repo } from "../types";

type Tab = "files" | "prs" | "commits" | "terminal";

export function RepoView() {
  const { repoId = "" } = useParams();
  const navigate = useNavigate();
  const { onWs, config } = useApp();
  const terminalEnabled = config?.terminal_enabled ?? false;

  const [repo, setRepo] = useState<Repo | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [prs, setPrs] = useState<Pr[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [tab, setTab] = useState<Tab>("files");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [remote, setRemote] = useState(false);
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
      setCommits(await api.commits(repoId, defBranch || other));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [repoId]);

  useEffect(() => {
    setRepo(null);
    setDiff(null);
    setBase("");
    setHead("");
    setTab("files");
    void load();
  }, [load]);

  // If the terminal gets disabled while the tab is active, fall back to files.
  useEffect(() => {
    if (!terminalEnabled && tab === "terminal") setTab("files");
  }, [terminalEnabled, tab]);

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
        remote,
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
  const defRef = repo.default_branch ?? branches[0]?.name ?? "HEAD";

  return (
    <div className={tab === "terminal" ? "page page--terminal" : "page"}>
      <div className="spread">
        <div>
          <h1>{repo.display_name}</h1>
          <div className="mono faint" style={{ fontSize: 12 }}>
            {repo.abs_path}
          </div>
        </div>
        <span className="ref">{repo.default_branch ?? "—"}</span>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === "files" ? "active" : ""}`} onClick={() => setTab("files")}>
          Files
        </button>
        <button className={`tab ${tab === "prs" ? "active" : ""}`} onClick={() => setTab("prs")}>
          Pull requests {openPrs.length > 0 && <span className="faint">({openPrs.length})</span>}
        </button>
        <button className={`tab ${tab === "commits" ? "active" : ""}`} onClick={() => setTab("commits")}>
          Commits
        </button>
        {terminalEnabled && (
          <button className={`tab ${tab === "terminal" ? "active" : ""}`} onClick={() => setTab("terminal")}>
            Terminal
          </button>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}

      {tab === "files" && (
        <FileBrowser repoId={repoId} branches={branches} defaultRef={defRef} />
      )}

      {tab === "prs" && (
        <>
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
              <select value={head} onChange={(e) => setHead(e.target.value)} style={{ width: 180 }}>
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
              <button onClick={viewDiff}>View diff</button>
            </div>
            <input placeholder="PR title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea
              placeholder="Description (optional)"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <label className="toggle" style={{ fontSize: 13 }}>
              <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
              <span>
                Also open on the remote (push <span className="mono">{head || "head"}</span> &amp; create
                a GitHub PR via <code>gh</code>)
                <div className="faint" style={{ fontSize: 12 }}>
                  Opt-in. Uses your <code>gh</code> login; the Claude review is also posted as a
                  comment on the remote PR. Merge stays on the remote.
                </div>
              </span>
            </label>
            <div className="row">
              <button className="primary" onClick={createPr} disabled={busy}>
                {busy ? "Opening…" : remote ? "Open local + remote PR" : "Open pull request"}
              </button>
              <span className="faint">Opening a PR triggers an automatic Claude review.</span>
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
        </>
      )}

      {tab === "terminal" && <Terminal repoId={repoId} />}

      {tab === "commits" && (
        <>
          <div className="row" style={{ marginBottom: 10 }}>
            <span className="faint">branch</span>
            <select
              defaultValue={defRef}
              onChange={(e) => void api.commits(repoId, e.target.value).then(setCommits)}
              style={{ width: 200 }}
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="list">
            {commits.map((c) => (
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
        </>
      )}
    </div>
  );
}
