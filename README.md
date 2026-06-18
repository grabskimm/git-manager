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

### Install globally (`gitm` / `gitmanager` on your PATH)

The build bundles the UI into the engine package, so a global install is self-contained.
Build first, then install the **engine package** (the monorepo root has no runtime deps):

```bash
npm install
npm run build
npm install -g ./packages/engine     # adds `gitm` and `gitmanager` to your PATH
gitm                                 # start the engine + open the UI from anywhere
```

After this, all the `gitm` commands below work from any directory. (To pick up later code
changes, re-run `npm run build` and `npm install -g ./packages/engine`.)

Then in the UI:

1. **Settings → Add a source directory.** Enter a local path — Linux/macOS
   (`/home/you/projects`, `~/code`) or Windows (`C:\Users\you\projects`) — **or** an
   `https`/`git`/`ssh`/`file` URL to clone a repo locally. GitManager scans recursively and
   lists every repo it finds.
2. Open a repo to **browse its files** (syntax-highlighted code, rendered Markdown), or pick
   a **base** and **head** branch and **Open pull request**.
3. The PR opens and Claude automatically reviews the diff (streamed into the thread). If
   `claude` isn't installed/logged in, the review is skipped cleanly with guidance — the PR
   is never blocked.
4. **Merge** (fast-forward or merge commit), **Close**, or — on a conflict — resolve locally
   and **Re-check**.

To run the engine without opening a browser (e.g. headless): `npm start -- --no-open`.

### Command line (`gitm`)

The CLI is installed as both `gitmanager` and the short alias **`gitm`**. `gitm` with no
arguments starts the engine; the subcommands talk to a running engine over loopback (reusing
the local token + Origin automatically), so you can drive local PRs without the browser:

```bash
gitm                                   # start the engine + open the UI (alias of `gitm start`)
gitm source add <path|url>             # add a source directory (or clone a URL)
gitm source list                       # list source directories
gitm source remove <id>                # remove a source directory
gitm scan                              # re-scan all source directories
gitm repos                             # list ingested repositories
gitm pr create                         # inside a tracked repo: auto-detects repo, branch, base, title
gitm pr create --title "My change"    # explicit title; repo/branch/base still auto-detected
gitm pr create --repo <id|name> --base main --head feature --title "My change" [--description "…"]
gitm pr list [--repo <id|name>]        # list pull requests
gitm pr view <pr-id>                   # show a PR and its review thread
gitm pr merge <pr-id>                  # merge (fast-forward / merge commit)
gitm pr close <pr-id>                  # close a PR
```

When run from inside a tracked git repo, `gitm pr create` behaves like `gh pr create`:
- **`--repo`** defaults to the repo whose path matches the current directory
- **`--head`** defaults to the current branch (`git branch --show-current`)
- **`--base`** defaults to the repo's default branch (usually `main`)
- **`--title`** defaults to the last commit subject on the current branch

All flags remain available as explicit overrides.

`--repo` accepts a repo id, exact display name, or an unambiguous substring/prefix. Creating
a PR triggers the automatic Claude review just like the UI. (See **Install globally** above to
put `gitm` on your `PATH`; otherwise invoke `node packages/engine/dist/cli.js`.)

### UI features

- **Dashboard home** — a friendly overview (open PRs, merged, agents running, recent PRs,
  quick jumps) instead of a bare repo list; repositories live in the left rail.
- **Code browsing** — a file tree per branch with syntax-highlighted source (`highlight.js`)
  and rendered **Markdown** (`marked` + DOMPurify), toggleable between rendered and source.
- **Dark / light mode** — toggle in the rail header (☀/☾); preference persists and the diff
  viewer and code highlighting follow the theme.
- **Repo chat** — a chat panel below the agents section talks to your authenticated `claude`
  about **all** repositories in the source list (read-only cross-repo metadata: branches,
  recent commits, paths). Responses stream over the WebSocket; degrades gracefully when
  `claude` isn't installed.

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

**Reply to Claude.** Once a review exists, a *Reply to Claude* box appears on the PR. Your
reply is posted to the thread and Claude answers with the **diff and full conversation** as
context (read-only), so you can push back, ask for clarification, or request a fix. Review,
reply, and chat all run read-only in an isolated directory — no file access.

**Implement with Claude (opt-in).** Enable `implement_enabled` in Settings to add an
**Implement** action on PRs. Claude then runs **with edit permissions inside a throwaway
detached worktree** checked out at the head commit, edits the files, and the result is
committed and the head branch advanced with a compare-and-swap `update-ref` — exactly like the
merge engine, so **your working tree is never touched**. The new commit shows up in the PR
diff immediately. This is the one place GitManager lets `claude` write to your repo, so it is
off by default.

## Agent observe panel (opt-in)

Enable it in Settings (or from the panel). GitManager then reads agent session
**transcripts read-only** (the durable contract), discovers running sessions, and binds each
to its repo (via the identity above, from the session's `cwd`), current branch, and a
matching open PR. Sessions are grouped by provider in the panel. Live updates come from
watching the transcript directories; for Claude Code a hook config is also merged into its
`settings.json` (best-effort) for lower latency.

**Multiple providers.** Beyond Claude Code, GitManager observes several agents out of the box,
all observe-only and failing soft when not installed:

- **Claude Code**, **Codex**, **Gemini CLI** — JSON/JSONL session transcripts, parsed by a
  tolerant reader (`agents/transcript.ts`) that locates the working directory across differing
  field names.
- **Antigravity** — a Windsurf/Codeium-based VS Code fork that stores "trajectories" as
  base64-protobuf inside its SQLite state store (`state.vscdb`); a dedicated source
  (`agents/antigravity.ts`) reads it via `better-sqlite3`.
- **GitHub Copilot CLI** — reads `~/.copilot/session-state/<id>/vscode.metadata.json`
  (`agents/copilot.ts`).

Sources that store paths in Windows form bind correctly from a Linux/WSL engine (and vice
versa) via automatic `C:\…` ↔ `/mnt/c/…` translation.

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
| `chat_enabled` | `false` | Enable the repo chat panel in the right sidebar |
| `terminal_enabled` | `false` | Enable the built-in terminal tab on each repo view |
| `implement_enabled` | `false` | Allow Claude to implement PR changes (writes files, commits to the head branch) |

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
