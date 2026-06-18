import { useState } from "react";
import { useApp } from "../state";
import { AgentPanel } from "./AgentPanel";
import { ChatPanel } from "./ChatPanel";

/**
 * Right column: agents on top, repo chat below.
 *
 * Both panels are ALWAYS mounted so chat state (history, streaming tokens)
 * survives a sidebar collapse. Collapse / chat-minimize are CSS-only toggles.
 */
export function RightSidebar() {
  const { config } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [chatMinimized, setChatMinimized] = useState(false);

  return (
    <aside className={`right-sidebar ${collapsed ? "collapsed" : ""}`}>
      {/* Expand handle — only visible when collapsed */}
      <button
        className="rs-expand-btn"
        onClick={() => setCollapsed(false)}
        title="Open agents & chat"
      >
        🤖
      </button>

      {/* Body always mounted; hidden by CSS when collapsed */}
      <div className="rs-body">
        <div className="rs-topbar">
          <button
            className="icon-btn"
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
            style={{ fontSize: 13 }}
          >
            ›
          </button>
        </div>

        <div className="agents-scroll">
          <AgentPanel />
        </div>

        {config?.chat_enabled && (
          <ChatPanel
            minimized={chatMinimized}
            onToggleMinimize={() => setChatMinimized((m) => !m)}
          />
        )}
      </div>
    </aside>
  );
}
