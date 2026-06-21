import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useApp } from "./state";
import { api } from "./api";
import { RightSidebar } from "./components/RightSidebar";
import { NewRepoDialog } from "./components/NewRepoDialog";
import { Home } from "./pages/Home";
import { RepoView } from "./pages/RepoView";
import { PrView } from "./pages/PrView";
import { Settings } from "./pages/Settings";

export function App() {
  const { repos, connected, error, reloadRepos, theme, toggleTheme } = useApp();
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState(0);
  const [newRepo, setNewRepo] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem("gm_rail_collapsed") === "1",
  );
  const filterRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    localStorage.setItem("gm_rail_collapsed", railCollapsed ? "1" : "0");
  }, [railCollapsed]);

  // Let any page (e.g. the dashboard) open the new-repo dialog without prop drilling.
  useEffect(() => {
    const open = () => setNewRepo(true);
    window.addEventListener("gm:new-repo", open);
    return () => window.removeEventListener("gm:new-repo", open);
  }, []);

  const scan = async () => {
    setScanning(true);
    try {
      await api.scan();
      await reloadRepos();
    } finally {
      setScanning(false);
    }
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) => r.display_name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q),
    );
  }, [repos, filter]);

  // Keep the keyboard selection within bounds as the filter changes.
  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Global shortcuts: Cmd/Ctrl+K or "/" focuses the repo filter; "g h"/"g s"
  // jump home/settings; "n" opens the new-repo dialog. Ignored while typing.
  useEffect(() => {
    let lastG = 0;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        if (railCollapsed) setRailCollapsed(false);
        setTimeout(() => filterRef.current?.focus(), 0);
        return;
      }
      if (typing) return;
      if (e.key === "n") {
        setNewRepo(true);
        return;
      }
      if (e.key === "g") {
        lastG = Date.now();
        return;
      }
      if (Date.now() - lastG < 600) {
        if (e.key === "h") navigate("/");
        if (e.key === "s") navigate("/settings");
        lastG = 0;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, railCollapsed]);

  const onFilterKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && filtered[sel]) {
      navigate(`/repos/${filtered[sel].id}`);
    } else if (e.key === "Escape") {
      setFilter("");
      filterRef.current?.blur();
    }
  };

  return (
    <div className={`app ${railCollapsed ? "rail-collapsed" : ""}`}>
      <aside className={`rail ${railCollapsed ? "collapsed" : ""}`}>
        {/* Collapsed strip: expand + new-repo, vertically stacked. */}
        <div className="rail-strip">
          <button
            className="icon-btn"
            onClick={() => setRailCollapsed(false)}
            title="Expand sidebar"
          >
            ☰
          </button>
          <button className="icon-btn" onClick={() => setNewRepo(true)} title="New repository (n)">
            ＋
          </button>
          <button
            className="icon-btn"
            onClick={scan}
            disabled={scanning}
            title="Refresh / re-scan"
          >
            {scanning ? "…" : "↻"}
          </button>
          <NavLink to="/settings" className="icon-btn" title="Settings">
            ⚙
          </NavLink>
        </div>

        {/* Full rail body. */}
        <div className="rail-full">
          <div className="rail-header">
            <button type="button" className="brand brand-btn" onClick={() => navigate("/")}>
              Git<span className="dot">●</span>Manager
            </button>
            <div className="row" style={{ gap: 4 }}>
              <button
                className="icon-btn"
                onClick={toggleTheme}
                title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              >
                {theme === "dark" ? "☀" : "☾"}
              </button>
              <span
                className="dotmark"
                title={connected ? "Engine connected" : "Disconnected"}
                style={{ color: connected ? "var(--green)" : "var(--red)" }}
              />
              <button
                className="icon-btn"
                onClick={() => setRailCollapsed(true)}
                title="Collapse sidebar"
              >
                ‹
              </button>
            </div>
          </div>

          {/* Primary actions, reachable without hunting corners. */}
          <div className="rail-actions">
            <button className="primary action-new" onClick={() => setNewRepo(true)}>
              ＋ New repository
            </button>
            <button className="icon-btn" onClick={scan} disabled={scanning} title="Refresh / re-scan">
              {scanning ? "…" : "↻"}
            </button>
            <NavLink to="/settings" className="icon-btn" title="Settings">
              ⚙
            </NavLink>
          </div>

          {!connected && (
            <div className="banner error" style={{ margin: 10 }}>
              Not connected to the engine.{" "}
              {error ? <span className="mono">{error}</span> : "Is it running?"}
            </div>
          )}

          <div className="rail-section rail-repos">
            <h3 style={{ margin: "6px 8px" }}>Repositories</h3>

            {repos.length > 0 && (
              <div style={{ padding: "0 8px 8px" }}>
                <input
                  ref={filterRef}
                  placeholder="Filter repos…  ( / )"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={onFilterKey}
                />
              </div>
            )}

            {repos.length === 0 && (
              <div className="faint" style={{ padding: "4px 10px", fontSize: 12 }}>
                No repos yet. Click <strong>New repository</strong> or add a source in Settings.
              </div>
            )}
            {repos.length > 0 && filtered.length === 0 && (
              <div className="faint" style={{ padding: "4px 10px", fontSize: 12 }}>
                No repos match “{filter}”.
              </div>
            )}
            {filtered.map((r, i) => (
              <NavLink
                key={r.id}
                to={`/repos/${r.id}`}
                className={({ isActive }) =>
                  `repo-item ${isActive ? "active" : ""} ${i === sel && filter ? "kbd-sel" : ""}`
                }
                onMouseEnter={() => setSel(i)}
              >
                <div>{r.display_name}</div>
                <div className="repo-id">{r.id.slice(0, 16)}</div>
              </NavLink>
            ))}
          </div>

          <div className="rail-footer faint">
            <small className="kbd">n</small> new · <small className="kbd">/</small> filter ·{" "}
            <small className="kbd">g h</small> home · <small className="kbd">g s</small> settings
          </div>
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/repos/:repoId" element={<RepoView />} />
          <Route path="/prs/:prId" element={<PrView />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>

      <RightSidebar />

      {newRepo && <NewRepoDialog onClose={() => setNewRepo(false)} />}
    </div>
  );
}
