import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../state";
import { DiffViewer } from "../components/DiffViewer";
import { StatusBadge } from "../components/StatusBadge";
import type { DiffResponse, PrDetail } from "../types";

export function PrView() {
  const { prId = "" } = useParams();
  const { onWs } = useApp();
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const streamRef = useRef("");

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

  return (
    <div className="page">
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
        <button disabled={busy !== null} onClick={() => act("review", () => api.rereview(pr.id))}>
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
              <span className={`author-${t.author}`}>{t.author}</span>
              <span className="faint">{t.kind.replace("_", " ")}</span>
              <span className="spacer" />
              <span className="faint">{new Date(t.created_at).toLocaleString()}</span>
            </div>
            <div className="thread-body">
              <pre>{t.body}</pre>
            </div>
          </div>
        ))}

        {streaming !== null && (
          <div className="streaming">
            <div className="author-claude" style={{ marginBottom: 6 }}>
              claude · reviewing…
            </div>
            <pre className="cursor-blink">{streaming}</pre>
          </div>
        )}

        {thread.length === 0 && streaming === null && (
          <div className="banner info">No activity yet.</div>
        )}
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <input
          placeholder="Add a comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && comment.trim()) {
              void act("comment", async () => {
                await api.comment(pr.id, comment.trim());
                setComment("");
              });
            }
          }}
        />
        <button
          disabled={!comment.trim() || busy !== null}
          onClick={() =>
            act("comment", async () => {
              await api.comment(pr.id, comment.trim());
              setComment("");
            })
          }
        >
          Comment
        </button>
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
