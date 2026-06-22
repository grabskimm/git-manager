import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../state";
import { api } from "../api";

function relTime(ts: string | null | undefined): string {
  if (!ts) return "";
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const PROVIDER_ICON: Record<string, string> = {
  "claude-code": "◆",
  codex: "⬡",
  antigravity: "◈",
  "gemini-cli": "✦",
};

export function AgentPanel() {
  const { agents, config, repos, reloadAgents, setConfig } = useApp();
  // Provider groups are collapsed by default; track which the user expanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleGroup = (src: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(src) ? next.delete(src) : next.add(src);
      return next;
    });

  useEffect(() => {
    if (!config?.agent_observe_enabled) return;
    const t = setInterval(() => void reloadAgents(), 5000);
    return () => clearInterval(t);
  }, [config?.agent_observe_enabled, reloadAgents]);

  const repoName = (id: string | null) =>
    id ? (repos.find((r) => r.id === id)?.display_name ?? id.slice(0, 12)) : null;

  const enabled = config?.agent_observe_enabled;
  const sessions = agents?.sessions ?? [];
  const sourceName = (id: string) => agents?.sources.find((s) => s.id === id)?.displayName ?? id;

  const running = sessions.filter((s) => s.status === "running").length;

  const groups = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const list = groups.get(s.source) ?? [];
    list.push(s);
    groups.set(s.source, list);
  }

  return (
    <div className="agents-section">
      {/* ---- header (only when observing; tab already labels "Agents") ---- */}
      {enabled && (
        <div className="agents-header">
          <span className="agents-title">Sessions</span>
          {sessions.length > 0 && (
            <span className={`agents-count-pill ${running > 0 ? "running" : ""}`}>
              {running > 0 ? `${running} running` : `${sessions.length} idle`}
            </span>
          )}
          <span className="spacer" />
          <button
            className="icon-btn"
            style={{ fontSize: 13, padding: "3px 7px" }}
            onClick={() => void api.refreshAgents().then(reloadAgents)}
            title="Refresh agent sessions"
          >
            ↻
          </button>
        </div>
      )}

      {/* ---- not enabled ---- */}
      {!enabled && (
        <div className="agents-empty-state">
          <div className="agents-empty-icon">🤖</div>
          <div className="agents-empty-title">Observe AI agents</div>
          <div className="agents-empty-sub">
            GitManager reads Claude Code, Codex, and other tools' session transcripts
            read-only and links each to its repo, branch, and PR.
          </div>
          <button
            className="primary"
            style={{ marginTop: 14, width: "100%" }}
            onClick={() => setConfig({ agent_observe_enabled: true })}
          >
            Enable observation
          </button>
        </div>
      )}

      {/* ---- enabled, no sessions ---- */}
      {enabled && sessions.length === 0 && (
        <div className="agents-empty-state compact">
          <div className="agents-empty-icon" style={{ fontSize: 22 }}>⌛</div>
          <div className="agents-empty-sub">
            No sessions yet. Start Claude Code, Codex, or another supported agent and it
            will appear here.
          </div>
        </div>
      )}

      {/* ---- session groups (collapsible per provider, collapsed by default) ---- */}
      {enabled &&
        [...groups.entries()].map(([src, list]) => {
          const isOpen = expanded.has(src);
          const groupRunning = list.filter((s) => s.status === "running").length;
          return (
          <div key={src} className={`agent-group ${isOpen ? "open" : "collapsed"}`}>
            <button
              className="agent-group-header"
              onClick={() => toggleGroup(src)}
              aria-expanded={isOpen}
              title={isOpen ? "Collapse" : "Expand"}
            >
              <span className="agent-group-caret">{isOpen ? "▾" : "▸"}</span>
              <span className="agent-provider-icon">
                {PROVIDER_ICON[src] ?? "◉"}
              </span>
              <span className="agent-provider-name">{sourceName(src)}</span>
              {groupRunning > 0 && <span className="session-status-dot running" />}
              <span className="agent-provider-count">{list.length}</span>
            </button>

            {isOpen &&
            list.map((s) => (
              <div key={s.id} className={`session-card ${s.status}`}>
                {/* status stripe is a ::before pseudo-element via CSS */}

                <div className="session-row">
                  {/* Left: repo + branch + PR */}
                  <div className="session-info">
                    <div className="session-repo-name">
                      {s.repo_id ? (
                        <Link to={`/repos/${s.repo_id}`}>{repoName(s.repo_id)}</Link>
                      ) : (
                        <span className="faint" title={s.cwd ?? ""}>
                          {(s.cwd ?? "").split("/").pop() || "unbound"}
                        </span>
                      )}
                    </div>
                    <div className="session-refs">
                      {s.branch && <span className="ref-sm">{s.branch}</span>}
                      {s.pr_id && (
                        <Link to={`/prs/${s.pr_id}`} className="ref-sm ref-sm--pr">
                          PR
                        </Link>
                      )}
                    </div>
                  </div>

                  {/* Right: status dot + time */}
                  <div className="session-right">
                    <div className={`session-status-dot ${s.status}`} />
                    <div className="session-time">{relTime(s.last_event_at)}</div>
                  </div>
                </div>

                <div className="session-footer">
                  <span className="session-id">{s.id.slice(0, 8)}</span>
                  <span className={`session-status-label ${s.status}`}>{s.status}</span>
                </div>
              </div>
            ))}
          </div>
          );
        })}
    </div>
  );
}
