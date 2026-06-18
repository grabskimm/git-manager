import { useState } from "react";
import { AgentPanel } from "./AgentPanel";
import { ChatPanel } from "./ChatPanel";

/** Right column: the agents observe section on top, repo chat below. */
export function RightSidebar() {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <aside className="right-sidebar collapsed">
        <button className="collapse-btn" onClick={() => setCollapsed(false)} title="Agents & chat">
          🤖
        </button>
      </aside>
    );
  }

  return (
    <aside className="right-sidebar">
      <div className="rs-collapse">
        <button className="icon-btn" onClick={() => setCollapsed(true)} title="Collapse">
          →
        </button>
      </div>
      <div className="agents-scroll">
        <AgentPanel />
      </div>
      <ChatPanel />
    </aside>
  );
}
