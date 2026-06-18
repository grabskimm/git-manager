import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../state";
import { Markdown } from "./Markdown";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

/**
 * A chat panel (below the agents section) that talks to the user's authenticated
 * Claude about all repositories in the source list. Responses stream over the
 * WebSocket; context is cross-repo metadata supplied by the engine.
 */
export function ChatPanel() {
  const { onWs, repos } = useApp();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeId = useRef<string | null>(null);
  const streamRef = useRef("");
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return onWs((e) => {
      const p = e.payload as { id?: string; token?: string; body?: string; reason?: string };
      if (!p || p.id !== activeId.current) return;
      if (e.type === "chat.token") {
        streamRef.current += p.token ?? "";
        setStreaming(streamRef.current);
      } else if (e.type === "chat.done") {
        setMessages((m) => [...m, { role: "assistant", content: p.body ?? streamRef.current }]);
        setStreaming(null);
        streamRef.current = "";
        activeId.current = null;
        setBusy(false);
      } else if (e.type === "chat.skipped") {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `_${p.reason ?? "Chat unavailable."}_` },
        ]);
        setStreaming(null);
        streamRef.current = "";
        activeId.current = null;
        setBusy(false);
      }
    });
  }, [onWs]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, streaming]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history = messages.slice(-12);
    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setBusy(true);
    streamRef.current = "";
    setStreaming("");
    try {
      const { id } = await api.chat(text, history);
      activeId.current = id;
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `_Error: ${(e as Error).message}_` }]);
      setStreaming(null);
      setBusy(false);
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <span className="brand">Repo chat</span>
        <span className="faint" style={{ fontSize: 11 }}>
          {repos.length} repo{repos.length === 1 ? "" : "s"} in context
        </span>
      </div>

      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && streaming === null && (
          <div className="faint" style={{ fontSize: 12, padding: "8px 4px" }}>
            Ask about any of your repositories — e.g. “which repos changed most recently?” or
            “where is auth handled across these projects?”. Context is read-only metadata
            across all repos in your source list.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-role">{m.role === "user" ? "you" : "claude"}</div>
            {m.role === "assistant" ? (
              <Markdown source={m.content} />
            ) : (
              <div className="chat-user-text">{m.content}</div>
            )}
          </div>
        ))}
        {streaming !== null && (
          <div className="chat-msg assistant">
            <div className="chat-role">claude</div>
            <pre className="cursor-blink" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {streaming}
            </pre>
          </div>
        )}
      </div>

      <div className="chat-input">
        <textarea
          rows={2}
          placeholder="Ask about your repos…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="primary" disabled={!input.trim() || busy} onClick={send}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
