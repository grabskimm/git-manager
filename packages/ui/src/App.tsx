import { useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useApp } from "./state";
import { api } from "./api";
import { AgentPanel } from "./components/AgentPanel";
import { Home } from "./pages/Home";
import { RepoView } from "./pages/RepoView";
import { PrView } from "./pages/PrView";
import { Settings } from "./pages/Settings";

export function App() {
  const { repos, connected, error, reloadRepos } = useApp();
  const [scanning, setScanning] = useState(false);
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

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-header">
          <span className="brand" onClick={() => navigate("/")} style={{ cursor: "pointer" }}>
            Git<span className="dot">●</span>Manager
          </span>
          <span
            className="dotmark"
            title={connected ? "Engine connected" : "Disconnected"}
            style={{ color: connected ? "var(--green)" : "var(--red)" }}
          />
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
          {repos.length === 0 && (
            <div className="faint" style={{ padding: "4px 10px", fontSize: 12 }}>
              No repos yet. Add a source directory in Settings.
            </div>
          )}
          {repos.map((r) => (
            <NavLink
              key={r.id}
              to={`/repos/${r.id}`}
              className={({ isActive }) => `repo-item ${isActive ? "active" : ""}`}
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
