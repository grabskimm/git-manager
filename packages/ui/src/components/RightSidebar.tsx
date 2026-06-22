import { useEffect, useMemo, useState } from "react";
import { useApp } from "../state";
import { AgentPanel } from "./AgentPanel";
import { ChatPanel } from "./ChatPanel";

type Tab = "chat" | "agents";

/**
 * Right column: Chat and Agents as tabs (not stacked) so each gets the full
 * height/width of the panel. Both stay mounted — switching tabs is a CSS
 * show/hide — so chat history and streaming survive a tab switch or collapse.
 */
export function RightSidebar() {
  const { config, agents } = useApp();
  const chatEnabled = config?.chat_enabled ?? false;

  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<Tab>("agents");
  const [unread, setUnread] = useState(false);

  // Fall back to the Agents tab whenever chat is turned off.
  useEffect(() => {
    if (!chatEnabled) setTab("agents");
  }, [chatEnabled]);

  const running = useMemo(
    () => (agents?.sessions ?? []).filter((s) => s.status === "running").length,
    [agents],
  );

  const openChat = () => {
    setTab("chat");
    setUnread(false);
  };

  return (
    <aside className={`right-sidebar ${collapsed ? "collapsed" : ""}`}>
      {/* Collapsed strip handle (also a peek-on-hover target via CSS) */}
      <button
        className="rs-expand-btn"
        onClick={() => setCollapsed(false)}
        title="Open chat & agents"
      >
        {running > 0 ? "🟢" : chatEnabled ? "💬" : "🤖"}
      </button>

      <div className="rs-body">
        <div className="rs-tabs">
          <button
            className={`rs-tab ${tab === "agents" ? "active" : ""}`}
            onClick={() => setTab("agents")}
          >
            🤖 Agents
            {running > 0 && <span className="rs-tab-badge running">{running}</span>}
          </button>
          {chatEnabled && (
            <button className={`rs-tab ${tab === "chat" ? "active" : ""}`} onClick={openChat}>
              💬 Chat
              {unread && tab !== "chat" && <span className="rs-unread" title="New reply" />}
            </button>
          )}

          <span className="spacer" />
          <button
            className="icon-btn"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Pin sidebar open" : "Auto-hide sidebar"}
            style={{ fontSize: 13 }}
          >
            {collapsed ? "📌" : "›"}
          </button>
        </div>

        <div className="rs-panels">
          <div className={`rs-panel rs-panel--scroll ${tab !== "agents" ? "hidden" : ""}`}>
            <AgentPanel />
          </div>
          {chatEnabled && (
            <div className={`rs-panel ${tab !== "chat" ? "hidden" : ""}`}>
              <ChatPanel active={tab === "chat"} onActivity={() => setUnread(true)} />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
