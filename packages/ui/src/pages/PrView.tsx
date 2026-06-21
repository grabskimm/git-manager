import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../state";
import { DiffViewer } from "../components/DiffViewer";
import { StatusBadge } from "../components/StatusBadge";
import { Markdown } from "../components/Markdown";
import type { DiffResponse, PrDetail } from "../types";

export function PrView() {
  const { prId = "" } = useParams();
  const { onWs, config, userName } = useApp();
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [commentFile, setCommentFile] = useState("");
  const [commentLine, setCommentLine] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [streamKind, setStreamKind] = useState<"review" | "reply" | "implement">("review");
  const [reply, setReply] = useState("");
  const streamRef = useRef("");

  // Changed files in the diff, offered as anchors for inline comments.
  const changedFiles = useMemo(() => {
    if (!diff?.diff) return [];
    const files = new Set<string>();
    for (const line of diff.diff.split("\n")) {
      let m = /^\+\+\+ b\/(.+)$/.exec(line);
      if (m && m[1] !== "/dev/null") files.add(m[1]);
      m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      if (m) files.add(m[1]);
    }
    return [...files].sort();
  }, [diff]);

  const submitComment = useCallback(async () => {
    const body = comment.trim();
    if (!body) return;
    const lineNum = Number(commentLine);
    await api.comment(prId, body, {
      file_path: commentFile || undefined,
      line: commentFile && Number.isFinite(lineNum) && lineNum > 0 ? lineNum : undefined,
    });
    setComment("");
    setCommentLine("");
  }, [comment, commentFile, commentLine, prId]);

  const sendReply = useCallback(async () => {
    const message = reply.trim();
    if (!message) return;
    setReply("");
    setStreamKind("reply");
    setError(null);
    try {
      await api.replyToReview(prId, message);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [reply, prId]);

  const sendImplement = useCallback(async () => {
    const message = reply.trim();
    if (!message) return;
    setReply("");
    setStreamKind("implement");
    setError(null);
    try {
      await api.implementReview(prId, message);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [reply, prId]);

  const load = useCallback(async () => {
    try {
      const d = await api.getPr(prId);
      setDetail(d);
      if (d.repo) {
        try {
          setDiff(await api.diff(d.repo.id, d.pr.base_ref, d.pr.head_ref));
        } catch {
          setDiff(null);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [prId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return onWs((e) => {
      const p = e.payload as { prId?: string; token?: string; reason?: string };
      if (p?.prId !== prId) return;
      switch (e.type) {
        case "review.start":
          streamRef.current = "";
          setStreaming("");
          break;
        case "review.token":
          streamRef.current += p.token ?? "";
          setStreaming(streamRef.current);
          break;
        case "review.done":
          setStreaming(null);
          streamRef.current = "";
          void load();
          break;
        case "review.skipped":
          setStreaming(null);
          void load();
          break;
        case "pr.updated":
          void load();
          break;
      }
    });
  }, [onWs, prId, load]);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!detail) {
    return (
      <div className="page">
        {error ? <div className="banner error">{error}</div> : <p className="subtle">Loading…</p>}
      </div>
    );
  }

  const { pr, thread, repo } = detail;
  const hasReview = thread.some((t) => t.author === "claude");

  return (
    <div className="page page--wide">
      <div className="row" style={{ marginBottom: 4 }}>
        <StatusBadge status={pr.status} />
        {repo && <Link to={`/repos/${repo.id}`} className="faint">{repo.display_name}</Link>}
      </div>
      <h1>{pr.title}</h1>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <span className="ref">{pr.head_ref}</span>
        <span className="faint">→</span>
        <span className="ref">{pr.base_ref}</span>
        {pr.merge_commit_sha && (
          <span className="sha">merged as {pr.merge_commit_sha.slice(0, 10)}</span>
        )}
        {pr.remote_url && (
          <a href={pr.remote_url} target="_blank" rel="noreferrer noopener" className="ref ref--pr">
            ↗ remote PR
          </a>
        )}
      </div>
      {pr.description && <p className="subtle">{pr.description}</p>}

      {error && <div className="banner error">{error}</div>}

      <div className="toolbar" style={{ margin: "12px 0" }}>
        {(pr.status === "open" || pr.status === "conflicted") && (
          <button
            className="primary"
            disabled={busy !== null}
            onClick={() => act("merge", () => api.mergePr(pr.id))}
          >
            {busy === "merge" ? "Merging…" : "Merge"}
          </button>
        )}
        {pr.status === "conflicted" && (
          <button disabled={busy !== null} onClick={() => act("refresh", () => api.refreshPr(pr.id))}>
            Re-check conflict
          </button>
        )}
        {pr.status !== "merged" && pr.status !== "closed" && (
          <button
            className="danger"
            disabled={busy !== null}
            onClick={() => act("close", () => api.closePr(pr.id))}
          >
            Close
          </button>
        )}
        <button
          disabled={busy !== null}
          onClick={() => {
            setStreamKind("review");
            void act("review", () => api.rereview(pr.id));
          }}
        >
          {busy === "review" ? "…" : "Re-run review"}
        </button>
      </div>

      {pr.status === "conflicted" && (
        <div className="banner">
          This PR has a merge conflict. Resolve it locally on{" "}
          <span className="mono">{pr.head_ref}</span>, then “Re-check conflict”.
        </div>
      )}

      <h2>Conversation</h2>
      <div className="stack">
        {thread.map((t) => (
          <div key={t.id} className="thread-entry">
            <div className="thread-head">
              <span className={`author-${t.author}`}>
                {t.author === "user" ? userName : t.author}
              </span>
              <span className="faint">{t.kind.replace("_", " ")}</span>
              {t.file_path && (
                <span className="ref mono" title="Inline comment">
                  📄 {t.file_path}
                  {t.line ? `:${t.line}` : ""}
                </span>
              )}
              <span className="spacer" />
              <span className="faint">{new Date(t.created_at).toLocaleString()}</span>
            </div>
            <div className="thread-body">
              {t.kind === "status_change" ? (
                <pre>{t.body}</pre>
              ) : (
                <Markdown source={t.body} />
              )}
            </div>
          </div>
        ))}

        {streaming !== null && (
          <div className="streaming">
            <div className="author-claude" style={{ marginBottom: 6 }}>
              claude ·{" "}
              {streamKind === "reply"
                ? "replying"
                : streamKind === "implement"
                  ? "implementing"
                  : "reviewing"}
              …
            </div>
            <pre className="cursor-blink">{streaming}</pre>
          </div>
        )}

        {thread.length === 0 && streaming === null && (
          <div className="banner info">No activity yet.</div>
        )}
      </div>

      {hasReview && (
        <div className="card stack" style={{ marginTop: 12 }}>
          <div className="row">
            <span className="author-claude">Reply to Claude</span>
            <span className="faint">
              Ask a follow-up about the review — Claude answers with the diff and this thread as
              context.
            </span>
          </div>
          <textarea
            placeholder="e.g. Why is that a problem? or: I disagree because…"
            rows={2}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && reply.trim()) {
                e.preventDefault();
                void sendReply();
              }
            }}
          />
          <div className="row wrap">
            <button
              className="primary"
              disabled={!reply.trim() || streaming !== null}
              onClick={() => void sendReply()}
            >
              {streaming !== null && streamKind === "reply" ? "Claude is replying…" : "Send reply"}
            </button>
            {config?.implement_enabled && pr.status !== "merged" && pr.status !== "closed" && (
              <button
                className="accent"
                disabled={!reply.trim() || streaming !== null}
                onClick={() => void sendImplement()}
                title="Claude edits files in a throwaway worktree and commits to the head branch"
              >
                {streaming !== null && streamKind === "implement"
                  ? "Claude is implementing…"
                  : "Implement"}
              </button>
            )}
            {config?.implement_enabled && (
              <span className="faint" style={{ fontSize: 12 }}>
                “Implement” lets Claude edit files and commit to{" "}
                <span className="mono">{pr.head_ref}</span>.
              </span>
            )}
          </div>
        </div>
      )}

      <div className="card stack" style={{ marginTop: 12 }}>
        <div className="row wrap">
          <span className="faint">on</span>
          <select
            value={commentFile}
            onChange={(e) => setCommentFile(e.target.value)}
            style={{ width: 260 }}
          >
            <option value="">the whole PR</option>
            {changedFiles.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          {commentFile && (
            <input
              type="number"
              min={1}
              placeholder="line"
              value={commentLine}
              onChange={(e) => setCommentLine(e.target.value)}
              style={{ width: 90 }}
            />
          )}
        </div>
        <input
          placeholder={commentFile ? `Comment on ${commentFile}` : "Add a comment"}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && comment.trim()) {
              void act("comment", submitComment);
            }
          }}
        />
        <div className="row">
          <button
            className="primary"
            disabled={!comment.trim() || busy !== null}
            onClick={() => act("comment", submitComment)}
          >
            Comment
          </button>
          {changedFiles.length > 0 && (
            <span className="faint">
              Anchor a note to a changed file (and optional line) for inline review.
            </span>
          )}
        </div>
      </div>

      {diff && (
        <>
          <h2>Diff — base...head</h2>
          <DiffViewer diff={diff.diff} stat={diff.stat} />
        </>
      )}
    </div>
  );
}
