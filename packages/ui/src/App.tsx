import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useApp } from "./state";
import { api } from "./api";
import { AgentPanel } from "./components/AgentPanel";
import { Home } from "./pages/Home";
import { RepoView } from "./pages/RepoView";
import { PrView } from "./pages/PrView";
import { Settings } from "./pages/Settings";

export function App() {
  const { repos, connected, error, reloadRepos, theme, toggleTheme } = useApp();
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

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
  // jump home/settings. Ignored while typing in an input/textarea.
  useEffect(() => {
    let lastG = 0;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        filterRef.current?.focus();
        return;
      }
      if (typing) return;
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
  }, [navigate]);

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
    <div className="app">
      <aside className="rail">
        <div className="rail-header">
          <span className="brand" onClick={() => navigate("/")} style={{ cursor: "pointer" }}>
            Git<span className="dot">●</span>Manager
          </span>
          <div className="row" style={{ gap: 6 }}>
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
          </div>
        </div>

        {!connected && (
          <div className="banner error" style={{ margin: 10 }}>
            Not connected to the engine.{" "}
            {error ? <span className="mono">{error}</span> : "Is it running?"}
          </div>
        )}

        <div className="rail-section">
          <div className="spread" style={{ margin: "0 8px 6px" }}>
            <h3 style={{ margin: 0 }}>Repositories</h3>
            <button onClick={scan} disabled={scanning} title="Re-scan source dirs">
              {scanning ? "…" : "↻"}
            </button>
          </div>

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
              No repos yet. Add a source directory in Settings.
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

        <div className="spacer" />
        <div className="rail-section">
          <NavLink
            to="/settings"
            className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
          >
            ⚙ Settings
          </NavLink>
          <div className="faint" style={{ padding: "6px 10px", fontSize: 11 }}>
            <small className="kbd">/</small> filter · <small className="kbd">g h</small> home ·{" "}
            <small className="kbd">g s</small> settings
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

      <AgentPanel />
    </div>
  );
}
