# GitManager

A **local-first** web app that gives a unified, GitHub-like view over many local git
repositories scattered across your filesystem — none of which live on GitHub or any remote.
Browse branches and diffs, open **local pull requests** against any repo, get an
**automatic Claude code review** before a PR lands, and watch which **AI coding agents** are
running and what each is working on.

Everything runs locally on loopback. Your `.git` is always canonical — there is no separate
object store, no import/push step, and no cloud.

---

## Why

Developers and AI agents accumulate local git repos that never touch a cloud forge. Viewing
and reviewing them is messy. GitManager points at a few top-level directories, discovers
every repo inside them, and presents one pane of glass. The local PR is the quality gate: on
agent-written repos that nothing else is looking at, an automatic Claude review of the diff
before it merges to `main` is the whole point.

## Architecture

```
┌──────────────┐    HTTP + WebSocket (one loopback origin)    ┌──────────────────────────┐
│  React UI    │ ◀───────────────────────────────────────▶  │  Engine (Node daemon)     │
│  (Vite SPA)  │                                              │  Fastify · ws · SQLite     │
└──────────────┘                                              │  system `git` subprocess   │
                                                              │  claude subprocess (review)│
                                                              │  Claude Code transcripts   │
                                                              └──────────────────────────┘
```

- **Engine** (`packages/engine`): a single daemon that walks configured directories, runs
  git operations (always via the real system `git`), holds a `better-sqlite3` metadata
  store, spawns the Claude review subprocess, and reads Claude Code session transcripts. It
  serves the built UI **and** the API on the **same loopback origin** — one process, one
  origin, no CORS, fully offline.
- **UI** (`packages/ui`): a thin React client over the engine's HTTP + WebSocket API.
- **WebSocket** is used for exactly two things: streaming the Claude review as it generates,
  and pushing live agent/PR events. Everything else is request/response.

## Quick start

Requirements: **Node ≥ 20** and **git**. For automatic reviews, the
[`claude`](https://docs.claude.com/en/docs/claude-code) CLI (logged in once). Everything
else is bundled.

```bash
npm install
npm run build          # builds the UI bundle, then the engine
npm start              # starts the engine on 127.0.0.1:4317 and opens the browser
```

Then in the UI:

1. **Settings → Add a source directory** (e.g. `/home/you/projects`). GitManager scans it
   recursively and lists every repo it finds.
2. Open a repo, pick a **base** and **head** branch, and **Open pull request**.
3. The PR opens and Claude automatically reviews the diff (streamed into the thread). If
   `claude` isn't installed/logged in, the review is skipped cleanly with guidance — the PR
   is never blocked.
4. **Merge** (fast-forward or merge commit), **Close**, or — on a conflict — resolve locally
   and **Re-check**.

To run the engine without opening a browser (e.g. headless): `npm start -- --no-open`.

### Development

```bash
npm run dev        # engine with hot reload (tsx watch) on :4317
npm run dev:ui     # Vite dev server on :5173, proxying /api and /ws to the engine
```

In dev, supply the token to the Vite server via `VITE_GM_TOKEN=$(cat ~/.gitmanager/token)`
or `localStorage.gm_token`. In production the engine injects the token into the served HTML
automatically.

## Security floor

"Localhost" is not a trust boundary — the engine runs `git merge` and launches `claude` with
your credentials, so it is treated as hostile from the first endpoint:

- **Binds `127.0.0.1` only** (never `0.0.0.0`).
- **Local token auth.** On first run a random token is written to `~/.gitmanager/token`
  (`0600`) and injected into the served UI. Every `/api/*` and WebSocket call must present it
  (`Authorization: Bearer <token>`); the WebSocket takes it as a `?token=` query param.
- **Origin check.** Every request's `Origin` must equal the engine's own origin — this
  blocks DNS-rebinding / CSRF from any website you visit.
- **No telemetry, no network calls except loopback.**

## Repo identity

With no remotes anywhere, identity is resolved deterministically on ingest (and never
changes once assigned):

1. If `<repo>/.gitmanager` exists, use the `id` recorded in it.
2. Else if the repo has commits, `id` = the **earliest root commit SHA**.
3. Else generate `gm-<uuid>`, write it to `<repo>/.gitmanager`, and use it.

This is the stable join key for the unified view (and for the deferred R2 sync). A repo
copied to a different path resolves to the **same id**.

## PR lifecycle

```
open ──merge (clean: ff or merge commit)──▶ merged   (records merge SHA; deletes head per config)
open ──merge (conflict)───────────────────▶ conflicted   (stays open & flagged)
conflicted ──(resolve locally; refresh)───▶ open
open ──close──────────────────────────────▶ closed
on PR open: trigger Claude review (async)
```

Merges are attempted in a **throwaway detached `git worktree`** so your checkouts are never
disturbed; on a clean result the base branch is advanced with a compare-and-swap
`update-ref`. Conflicts are aborted cleanly and surfaced as "resolve locally" — there is no
in-app conflict editor in v1. Merge logic is never hand-rolled; system `git` does the work.

## Claude review

The review runs as a local subprocess using your existing `claude` login (no Actions runner,
no extra config):

- The prompt is an **editable template** at `<repo>/.gitmanager-review-prompt.md`, created
  with a sensible default on first review. Customize it per repo.
- Output streams token-by-token over the WebSocket into the PR thread and is persisted as a
  `claude`-authored review entry.
- If `claude` is absent, unauthenticated, or errors, the review is marked **skipped** with
  guidance — the PR is never hard-failed.

## Agent observe panel (opt-in)

Enable it in Settings (or from the panel). GitManager then reads Claude Code session
**transcripts read-only** (the durable contract), discovers running sessions, and binds each
to its repo (via the identity above, from the session's `cwd`), current branch, and a
matching open PR. Live updates come from watching the transcript directory; a hook config is
also merged into Claude Code's `settings.json` (best-effort) for lower latency.

All agent data flows through a single `AgentSource` adapter (`packages/engine/src/agents`).
The UI renders against each source's `capabilities`, so **control buttons simply don't
exist** until a source flips `control: true`. In v1 the Claude Code source is
`{ observe: true, control: false }` and the control methods throw `NotSupported`.

## Configuration

Stored in SQLite (`config` table), editable in Settings:

| Key | Default | Meaning |
| --- | --- | --- |
| `review_on_pr_open` | `true` | Run the Claude review automatically when a PR opens |
| `delete_head_on_merge` | `true` | Delete the head branch after a successful merge |
| `agent_observe_enabled` | `false` | Enable the read-only agent observe panel |

Environment overrides: `GITMANAGER_PORT` (default `4317`), `GITMANAGER_HOME` (default
`~/.gitmanager`), `GITMANAGER_CLAUDE_BIN` (default `claude`).

## Tests

```bash
npm test
```

Covers identity resolution (root-commit / marker / generated / copy-stability), the merge
engine (fast-forward, merge commit, conflict, head deletion), the full PR lifecycle over
HTTP (ingest idempotency, auto-review skip, merge, conflict → recovery), the Claude Code
agent adapter (discovery + repo/branch/PR binding, capability flags, `NotSupported`), and a
security smoke test (token + Origin + loopback bind).

## Project layout

```
packages/
  engine/   Fastify daemon: git, db, identity, scan, merge, review, agents, routes, ws
  ui/       React + Vite SPA: rail, repo view, PR view, agent panel, settings
```

## Deferred modules (seams exist; code later)

- **R2 sync** — two-tier: git objects via a bare git remote on R2 (let `git push`/`fetch`
  resolve), plus a SQLite metadata bundle under a separate prefix. Identity is already
  stamped; local `.git` stays canonical.
- **Agent control** — implement the stubbed `start`/`stop`/`resume` and flip the capability
  flag; the UI is already capability-driven.
- **Additional agent sources** — new `AgentSource` implementations.
- **Cloud-hosted UI** — a separate origin with its own auth (an explicit security escalation,
  not the loopback default).

## Non-goals (v1)

Local only (no GitHub/GitLab/remotes). Simple branch-and-merge (no squash/rebase-on-merge).
Observe-only agents. No cloud. No conflict-resolution editor.
