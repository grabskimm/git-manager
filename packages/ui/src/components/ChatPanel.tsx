import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../state";
import { Markdown } from "./Markdown";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  /** Whether the chat tab is currently visible (drives unread bubbling). */
  active: boolean;
  /** Called when a reply arrives while the chat tab isn't visible. */
  onActivity: () => void;
}

const MODELS: { value: string; label: string }[] = [
  { value: "", label: "Default" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];

const SUGGESTIONS = [
  "Which repos changed most recently?",
  "Summarize what I worked on this week",
  "Any repos with uncommitted-looking churn?",
];

export function ChatPanel({ active, onActivity }: Props) {
  const { onWs, repos, userName } = useApp();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string>(() => localStorage.getItem("gm_chat_model") ?? "");
  const [selectedRepo, setSelectedRepo] = useState<string>(
    () => localStorage.getItem("gm_chat_repo") ?? "",
  );
  const activeId = useRef<string | null>(null);
  const streamRef = useRef("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

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
        if (!activeRef.current) onActivity();
      } else if (e.type === "chat.skipped") {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `_${p.reason ?? "Chat unavailable."}_` },
        ]);
        setStreaming(null);
        streamRef.current = "";
        activeId.current = null;
        setBusy(false);
        if (!activeRef.current) onActivity();
      }
    });
  }, [onWs, onActivity]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, streaming]);

  const sendText = async (text: string) => {
    if (!text.trim() || busy) return;
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

  const scopeName = repos.find((r) => r.id === selectedRepo)?.display_name;

  return (
    <div className="chat-panel">
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

      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && streaming === null && (
          <div className="chat-empty">
            <div className="chat-empty-icon">💬</div>
            <div className="chat-empty-title">Ask about your repositories</div>
            <div className="chat-empty-sub">
              {scopeName
                ? `Scoped to ${scopeName}. Switch scope above to ask across all repos.`
                : "Read-only metadata — branches, recent commits, paths. Pick a single repo above to focus."}
            </div>
            <div className="chat-chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chat-chip" onClick={() => void sendText(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
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
          placeholder={scopeName ? `Ask about ${scopeName}…` : "Ask about your repos…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendText(input);
            }
          }}
        />
        <button className="primary" disabled={!input.trim() || busy} onClick={() => void sendText(input)}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
