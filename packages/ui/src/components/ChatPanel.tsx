import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../state";
import { Markdown } from "./Markdown";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  minimized: boolean;
  onToggleMinimize: () => void;
}

const MODELS: { value: string; label: string }[] = [
  { value: "", label: "Default" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];

export function ChatPanel({ minimized, onToggleMinimize }: Props) {
  const { onWs, repos, userName } = useApp();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasActivity, setHasActivity] = useState(false);
  const [model, setModel] = useState<string>(() => localStorage.getItem("gm_chat_model") ?? "");
  const [selectedRepo, setSelectedRepo] = useState<string>(
    () => localStorage.getItem("gm_chat_repo") ?? "",
  );
  const activeId = useRef<string | null>(null);
  const streamRef = useRef("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const minimizedRef = useRef(minimized);

  useEffect(() => {
    minimizedRef.current = minimized;
    if (!minimized) setHasActivity(false);
  }, [minimized]);

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
        if (minimizedRef.current) setHasActivity(true);
      } else if (e.type === "chat.skipped") {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `_${p.reason ?? "Chat unavailable."}_` },
        ]);
        setStreaming(null);
        streamRef.current = "";
        activeId.current = null;
        setBusy(false);
        if (minimizedRef.current) setHasActivity(true);
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
      const { id } = await api.chat(text, history, model || undefined, selectedRepo || undefined);
      activeId.current = id;
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `_Error: ${(e as Error).message}_` }]);
      setStreaming(null);
      setBusy(false);
    }
  };

  return (
    <div className={`chat-panel ${minimized ? "chat-minimized" : ""}`}>
      <div className="chat-head">
        <div className="row" style={{ gap: 6 }}>
          <span className="chat-title">Chat</span>
          {hasActivity && minimized && <span className="chat-unread-dot" title="New response" />}
        </div>
        <button
          className="icon-btn"
          onClick={onToggleMinimize}
          title={minimized ? "Expand chat" : "Minimize chat"}
          style={{ fontSize: 12, padding: "3px 7px" }}
        >
          {minimized ? "▲" : "▼"}
        </button>
      </div>

      <div className="chat-controls">
        <select
          className="chat-scope-select"
          value={selectedRepo}
          onChange={(e) => {
            setSelectedRepo(e.target.value);
            localStorage.setItem("gm_chat_repo", e.target.value);
          }}
          title="Limit the chat context to a single repository"
        >
          <option value="">All repos ({repos.length})</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.display_name}
            </option>
          ))}
        </select>
        <select
          className="chat-model-select"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            localStorage.setItem("gm_chat_model", e.target.value);
          }}
          title="Model used for chat"
        >
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {/* Body and input stay mounted; hidden via CSS when minimized */}
      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && streaming === null && (
          <div className="chat-hint">
            {selectedRepo
              ? "Ask about the selected repository. Switch the scope above to ask across all repos."
              : 'Ask about any of your repositories — e.g. "which repos changed most recently?". Use the scope selector above to focus on a single repo. Context is read-only metadata.'}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-role">{m.role === "user" ? userName : "claude"}</div>
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
            <pre className="cursor-blink" style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13 }}>
              {streaming}
            </pre>
          </div>
        )}
      </div>

      <div className="chat-input">
        <textarea
          rows={2}
          placeholder={
            selectedRepo
              ? `Ask about ${repos.find((r) => r.id === selectedRepo)?.display_name ?? "this repo"}…`
              : "Ask about your repos…"
          }
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
