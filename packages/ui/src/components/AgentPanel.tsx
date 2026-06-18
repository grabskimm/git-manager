import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../state";
import { api } from "../api";

export function AgentPanel() {
  const { agents, config, repos, reloadAgents, setConfig } = useApp();
  const [collapsed, setCollapsed] = useState(false);

  // Poll as a fallback in case the file-watch stream misses an event.
  useEffect(() => {
    if (!config?.agent_observe_enabled) return;
    const t = setInterval(() => void reloadAgents(), 5000);
    return () => clearInterval(t);
  }, [config?.agent_observe_enabled, reloadAgents]);

  if (collapsed) {
    return (
      <aside className="agent-panel collapsed">
        <button className="collapse-btn" onClick={() => setCollapsed(false)} title="Agents">
          🤖
        </button>
      </aside>
    );
  }

  const repoName = (id: string | null) =>
    id ? repos.find((r) => r.id === id)?.display_name ?? id.slice(0, 12) : null;

  const enabled = config?.agent_observe_enabled;
  const controlAvailable = agents?.sources.some((s) => s.capabilities.control) ?? false;
  const sessions = agents?.sessions ?? [];

  return (
    <aside className="agent-panel">
      <div className="rail-header">
        <span className="brand">Agents</span>
        <button onClick={() => setCollapsed(true)} title="Collapse">
          →
        </button>
      </div>

      {!enabled ? (
        <div className="rail-section">
          <div className="banner info">
            The agent observe panel is opt-in. When enabled, GitManager reads Claude Code
            session transcripts <strong>read-only</strong> and binds each to its repo,
            branch, and matching PR.
          </div>
          <button className="primary" onClick={() => setConfig({ agent_observe_enabled: true })}>
            Enable observation
          </button>
        </div>
      ) : (
        <>
          <div className="rail-section">
            <div className="spread">
              <span className="faint" style={{ fontSize: 12 }}>
                {sessions.length} session{sessions.length === 1 ? "" : "s"} · observe-only
              </span>
              <button onClick={() => void api.refreshAgents().then(reloadAgents)}>↻</button>
            </div>
            {!controlAvailable && (
              <div className="faint" style={{ fontSize: 11, margin: "6px 0" }}>
                Control (start/stop) is unavailable for these sources.
              </div>
            )}
          </div>

          {sessions.length === 0 && (
            <div className="rail-section faint" style={{ fontSize: 13 }}>
              No Claude Code sessions found in ingested repos. Start a session in one of your
              repositories and it will appear here.
            </div>
          )}

          {sessions.map((s) => (
            <div key={s.id} className="agent-session">
              <div className="spread">
                <span className={`badge ${s.status}`}>
                  <span className="dotmark" />
                  {s.status}
                </span>
                <span className="faint" style={{ fontSize: 11 }}>
                  {s.source}
                </span>
              </div>
              <div style={{ marginTop: 6 }}>
                {s.repo_id ? (
                  <Link to={`/repos/${s.repo_id}`}>{repoName(s.repo_id)}</Link>
                ) : (
                  <span className="faint">unbound · {s.cwd}</span>
                )}
              </div>
              <div className="row wrap" style={{ marginTop: 4 }}>
                {s.branch && <span className="ref">{s.branch}</span>}
                {s.pr_id && (
                  <Link to={`/prs/${s.pr_id}`} className="ref">
                    PR
                  </Link>
                )}
              </div>
              <div className="faint mono" style={{ fontSize: 10, marginTop: 4 }}>
                {s.id.slice(0, 8)}
                {s.last_event_at ? ` · ${new Date(s.last_event_at).toLocaleTimeString()}` : ""}
              </div>
            </div>
          ))}
        </>
      )}
    </aside>
  );
}
