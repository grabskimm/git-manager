import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../state";
import { StatusBadge } from "../components/StatusBadge";
import type { Pr } from "../types";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function Home() {
  const { repos, sourceDirs, agents } = useApp();
  const [prs, setPrs] = useState<Pr[]>([]);

  useEffect(() => {
    void api.listPrs().then(setPrs).catch(() => setPrs([]));
  }, [repos.length]);

  const openPrs = useMemo(
    () => prs.filter((p) => p.status === "open" || p.status === "conflicted"),
    [prs],
  );
  const runningAgents = useMemo(
    () => (agents?.sessions ?? []).filter((s) => s.status === "running").length,
    [agents],
  );
  const recent = useMemo(
    () => [...prs].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6),
    [prs],
  );
  const repoName = (id: string) => repos.find((r) => r.id === id)?.display_name ?? id.slice(0, 8);

  if (sourceDirs.length === 0) {
    return (
      <div className="page">
        <div className="empty">
          <div className="big">Welcome to GitManager 👋</div>
          <p className="subtle" style={{ maxWidth: 520, margin: "0 auto 20px" }}>
            A unified, local-first home for your scattered git repositories — browse code,
            open local pull requests, and get automatic Claude reviews. Everything runs on
            loopback; your <code>.git</code> stays canonical.
          </p>
          <div className="row" style={{ justifyContent: "center" }}>
            <button
              className="primary"
              onClick={() => window.dispatchEvent(new Event("gm:new-repo"))}
            >
              ＋ Create your first repository
            </button>
            <Link to="/settings">
              <button>Add an existing folder →</button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="hero">
        <h1>{greeting()} 👋</h1>
        <p className="subtle">
          Here's what's happening across your {repos.length} local repositor
          {repos.length === 1 ? "y" : "ies"}.
        </p>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="num">{repos.length}</div>
          <div className="label">Repositories</div>
        </div>
        <div className="stat-card green">
          <div className="num">{openPrs.length}</div>
          <div className="label">Open PRs</div>
        </div>
        <div className="stat-card accent">
          <div className="num">{prs.filter((p) => p.status === "merged").length}</div>
          <div className="label">Merged</div>
        </div>
        <div className="stat-card purple">
          <div className="num">{runningAgents}</div>
          <div className="label">Agents running</div>
        </div>
      </div>

      <div className="quick-actions">
        <button className="primary" onClick={() => window.dispatchEvent(new Event("gm:new-repo"))}>
          ＋ New repository
        </button>
        <Link to="/settings">
          <button>Add source directory</button>
        </Link>
        {repos[0] && (
          <Link to={`/repos/${repos[0].id}`}>
            <button>Browse {repos[0].display_name}</button>
          </Link>
        )}
      </div>

      <h2>Recent pull requests</h2>
      {recent.length === 0 ? (
        <div className="banner info">
          No pull requests yet. Open one from any repository to get an automatic Claude review.
        </div>
      ) : (
        <div className="list">
          {recent.map((p) => (
            <Link key={p.id} to={`/prs/${p.id}`} className="list-row">
              <StatusBadge status={p.status} />
              <strong>{p.title}</strong>
              <span className="spacer" />
              <span className="faint">{repoName(p.repo_id)}</span>
              <span className="ref">{p.head_ref}</span>
            </Link>
          ))}
        </div>
      )}

      {repos.length > 0 && (
        <>
          <h2>Jump to a repository</h2>
          <div className="row wrap">
            {repos.slice(0, 12).map((r) => (
              <Link key={r.id} to={`/repos/${r.id}`}>
                <button>{r.display_name}</button>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
