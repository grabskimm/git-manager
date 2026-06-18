import { Link } from "react-router-dom";
import { useApp } from "../state";

export function Home() {
  const { repos, sourceDirs } = useApp();

  if (sourceDirs.length === 0) {
    return (
      <div className="page">
        <div className="empty">
          <div className="big">Welcome to GitManager</div>
          <p className="subtle">
            A unified, local-first view over your scattered git repositories — with
            local pull requests and automatic AI review. Everything runs on loopback;
            your <code>.git</code> is always canonical.
          </p>
          <p>
            <Link to="/settings">
              <button className="primary">Add a source directory →</button>
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Repositories</h1>
      <p className="subtle">
        {repos.length} repositor{repos.length === 1 ? "y" : "ies"} discovered across{" "}
        {sourceDirs.length} source director{sourceDirs.length === 1 ? "y" : "ies"}.
      </p>
      {repos.length === 0 ? (
        <div className="banner info">
          No git repositories found yet. Add more source directories or re-scan.
        </div>
      ) : (
        <div className="list">
          {repos.map((r) => (
            <Link key={r.id} to={`/repos/${r.id}`} className="list-row">
              <strong>{r.display_name}</strong>
              <span className="ref">{r.default_branch ?? "—"}</span>
              <span className="spacer" />
              <span className="sha">{r.id.slice(0, 16)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
