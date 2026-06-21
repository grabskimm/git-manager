# GitManager

**A GitHub-style home for the git repos that live only on your machine.**

GitManager is a local-first web app. Point it at the folders where you keep your projects, and
it gives you one clean dashboard over every git repo it finds — browse code, open **pull
requests against your local repos**, get an **automatic Claude code review** before you merge,
and optionally back everything up to the cloud. No GitHub account required, nothing leaves your
machine unless you explicitly ask it to.

Your `.git` is always the source of truth. There's no import step, no syncing to a server, no
cloud middleman.

---

## The problem it solves

If you (or your AI coding agents) build a lot of small projects, most of them never make it to
GitHub. They just pile up in `~/projects` as loose git repos. That means:

- No nice UI to browse them — you're back to `cd`-ing around and running `git log`.
- No pull-request workflow, so changes land on `main` with nobody (and nothing) reviewing them.
- No easy way to move a repo to another laptop without setting up a remote.

GitManager fixes all three. It's **one pane of glass** for your local repos, with a real PR
flow and an automatic Claude review acting as the quality gate — which matters most for
agent-written code that nothing else is checking.

## What you can do

- 🗂 **See all your repos at once** — recursive scan of the folders you choose, with filter/search.
- ➕ **Create a new repo** right from the UI (or `gitm`), pre-initialized and tracked instantly.
- 📄 **Browse code** with syntax highlighting and rendered Markdown, per branch.
- 🔀 **Open local pull requests**, view the diff, merge (fast-forward or merge commit), or close.
- 🤖 **Automatic Claude review** on every PR — streamed into the thread; reply to it, or let it
  implement the fix (opt-in).
- ☁️ **Back up & restore** repos to S3 / Cloudflare R2 / Azure / a local folder — move between
  machines without GitHub.
- 👀 **Watch your AI agents** (Claude Code, Codex, Gemini, Antigravity, Copilot CLI) — see what's
  running and which repo/branch/PR each is on.
- 🌐 **Optional remote PRs** — if a repo has a GitHub `origin`, mirror a PR there via `gh`.

Everything except the explicit opt-ins (remote PRs, backup) runs **fully offline on loopback**.

---

## Quick start

You need **Node ≥ 20** and **git**. For Claude reviews, install the
[`claude`](https://docs.claude.com/en/docs/claude-code) CLI and log in once — everything else
is bundled.

```bash
npm install
npm run build     # builds the UI, bundles it into the engine
npm start         # serves on http://127.0.0.1:4317 and opens your browser
```

Then, in the UI:

1. Click **➕ New repository** to spin up a fresh repo, **or** go to **Settings → Sources** and
   add a folder you already keep projects in (e.g. `~/projects`). GitManager scans it and lists
   every repo inside.
2. Open a repo to **browse files**, or switch to the **Pull requests** tab, pick a base and head
   branch, and **Open pull request**.
3. The PR opens and **Claude reviews the diff automatically** (streamed live). No `claude`
   installed? The review is skipped cleanly — your PR is never blocked.
4. **Merge**, **Close**, or reply to the review. Done.

Headless (no browser)? `npm start -- --no-open`.

### Desktop app

Prefer a native window over a browser tab? GitManager also ships as a standalone
desktop app for **Windows, macOS, and Linux** that runs the same engine + UI
headlessly and 100% locally — no terminal, no manual server start — with the app
version in the sidebar and built-in auto-update.

```bash
npm run desktop        # build everything and launch the native app
npm run desktop:dist   # build local installers (packages/desktop/release/)
```

See [`docs/desktop.md`](docs/desktop.md) for the framework decision, the release
process (tag → build → publish → auto-update), and CI signing setup, and
[`docs/desktop-credentials.md`](docs/desktop-credentials.md) for generating the
signing certificates and credentials.

### Put `gitm` on your PATH

The UI is bundled into the engine, so a global install is self-contained:

```bash
npm install && npm run build
npm install -g ./packages/engine    # adds `gitm` and `gitmanager`
gitm                                # start it from anywhere
```

Re-run those last two lines to pick up code changes later.

---

## Using the UI

- **Left sidebar** — your repos, with a filter box. Collapse it with **‹** (or expand with **☰**)
  to give code more room; the choice is remembered. Top of the sidebar has **New repository**,
  **refresh/re-scan ↻**, and **Settings ⚙** so you're never hunting in corners.
- **Repo view** — tabs for **Files**, **Pull requests**, **Commits**, and (opt-in) **Terminal**.
  The file viewer fills the screen; long lines scroll, or hit **↩ wrap** to soft-wrap them.
- **Right sidebar** — the **agent observe** panel and **repo chat** (both opt-in in Settings).
  Collapse it the same way.
- **Dark / light** — toggle (☀/☾) in the sidebar header; it persists.

**Keyboard shortcuts:** `n` new repo · `/` or `Cmd/Ctrl+K` focus the repo filter · `g h` home ·
`g s` settings · arrows + `Enter` to pick a repo from the filter.

## Using the command line (`gitm`)

`gitm` with no arguments starts the engine. The subcommands talk to a running engine over
loopback (reusing the local token automatically), so you can drive PRs without the browser:

```bash
gitm                                   # start the engine + open the UI
gitm source add <path|url>             # add a source folder (or clone a URL into one)
gitm source list                       # list source folders
gitm source remove <id>                # remove a source folder
gitm scan                              # re-scan all source folders
gitm repos                             # list tracked repositories

gitm pr create                         # inside a tracked repo: auto-detects repo/branch/base/title
gitm pr create --title "My change"     # explicit title; the rest still auto-detected
gitm pr create --remote                # ALSO open a PR on GitHub via `gh` (opt-in)
gitm pr list [--repo <id|name>]        # list pull requests
gitm pr view <pr-id>                   # show a PR + its review thread
gitm pr merge <pr-id>                  # merge (fast-forward / merge commit)
gitm pr close <pr-id>                  # close a PR

gitm sync status                       # show backup backends + the remote manifest
gitm sync push [--repo <id|name>]      # back up now (local → remote)
gitm sync pull <gm-id> --into <dir>    # restore a repo on a fresh machine (remote → local)
```

Run from inside a tracked repo, `gitm pr create` behaves like `gh pr create`: `--repo` defaults
to the current directory's repo, `--head` to the current branch, `--base` to the default branch,
and `--title` to the last commit subject. All are overridable. `--repo` accepts an id, exact
name, or unambiguous prefix.

---

## How it works

```
┌──────────────┐   HTTP + WebSocket (one loopback origin)   ┌────────────────────────────┐
│   React UI   │ ◀──────────────────────────────────────▶ │  Engine (Node daemon)       │
│  (Vite SPA)  │                                            │  Fastify · ws · SQLite      │
└──────────────┘                                            │  system `git` subprocess    │
                                                            │  `claude` subprocess (review)│
                                                            │  agent transcripts (read)   │
                                                            └────────────────────────────┘
```

- **Engine** (`packages/engine`) — one daemon that scans folders, runs **real `git`** for every
  operation, keeps a `better-sqlite3` metadata store, spawns the Claude review, and reads agent
  transcripts. It serves the built UI **and** the API on the **same loopback origin** — one
  process, no CORS, offline by default.
- **UI** (`packages/ui`) — a thin React client over the engine's HTTP + WebSocket API.
- **WebSocket** carries exactly two things: the streaming Claude review, and live agent/PR
  events. Everything else is plain request/response.

## Security floor

"Localhost" isn't a trust boundary — the engine runs `git merge` and launches `claude` with
your credentials — so it's locked down from the first endpoint:

- **Binds `127.0.0.1` only** (never `0.0.0.0`).
- **Local token auth** — a random token is written to `~/.gitmanager/token` (`0600`) on first
  run and injected into the served UI. Every `/api/*` call and WebSocket upgrade must present it.
- **Origin check** on every request — blocks DNS-rebinding / CSRF from any site you visit.
- **No telemetry, no network calls except loopback** (unless you opt into remote PRs / backup,
  and then only to the provider you configured).

## Repo identity

With no remotes guaranteed, each repo gets a stable id, resolved once and never changed:

1. If `<repo>/.gitmanager` exists, use the `id` in it.
2. Else, if the repo has commits, `id` = the **earliest root commit SHA**.
3. Else, generate `gm-<uuid>` and write it to `<repo>/.gitmanager`.

A repo copied to a new path resolves to the **same id** — that's the join key for the unified
view and for backups.

## PR lifecycle

```
open ──merge (clean)──────────────▶ merged      (records merge SHA; optionally deletes head)
open ──merge (conflict)───────────▶ conflicted  (stays open & flagged)
conflicted ──(resolve locally)────▶ open
open ──close──────────────────────▶ closed
on open: Claude review runs async
```

Merges happen in a **throwaway detached `git worktree`**, so your checkouts are never disturbed;
a clean result advances the base branch with a compare-and-swap `update-ref`. Conflicts abort
cleanly and ask you to resolve locally (no in-app conflict editor in v1). Merge logic is never
hand-rolled — system `git` does the work.

### Remote PRs (opt-in)

Everything is local by default. If a repo has a GitHub `origin`, opt in per-PR (the `--remote`
flag, or the *Also open on the remote* checkbox) to **also** push the head branch and open a real
GitHub PR via the **`gh` CLI** (your existing `gh auth login`; no tokens stored). The Claude
review is also posted as a comment there, and the remote URL is linked from the PR view.
**Merging stays on the remote.** No-op with a note if `gh` is missing or the remote isn't GitHub.

## Claude review

Runs as a local subprocess using your existing `claude` login — no Actions runner, no extra
config:

- The prompt is an **editable template** at `<repo>/.gitmanager-review-prompt.md` (created with a
  sensible default on first review). Tweak it per repo.
- Output streams token-by-token into the PR thread and is saved as a `claude`-authored entry.
- If `claude` is absent/unauthenticated/errors, the review is marked **skipped** with guidance —
  the PR is never hard-failed.
- **Reply to Claude** — once a review exists, a reply box appears; Claude answers with the diff +
  full conversation as context (read-only).
- **Implement with Claude (opt-in)** — enable `implement_enabled` to add an **Implement** action.
  Claude edits files in a throwaway worktree at the head commit and commits the result to the
  head branch (same engine as merge), so **your working tree is never touched**.

## Backup & sync (opt-in)

A storage backend for **moving repos between machines without GitHub**. It is *not* a git remote
— no git ever runs server-side; the store just holds backups.

- **What's stored** — each repo as a `git bundle --all`, keyed by its stable id, as timestamped
  snapshots + a `latest` pointer (last 10 kept, auto-pruned). A top-level `manifest.json` lets a
  fresh device discover what to restore.
- **Backends** — **S3**, **Cloudflare R2** (via `wrangler`), **Azure Blob**, and a local
  **filesystem** target (great for a NAS). Enable one or many; all are written on each push.
- **Credentials** — none stored by GitManager. You just log in per device (AWS chain / `aws sso
  login`, `npx wrangler login`, `az login`). A backend that isn't logged in shows "not ready" and
  is skipped.
- **Back up** (local → remote) — manual via *⤴ Back up all now* / per-repo *⟳ Sync*, or turn on
  `sync_enabled` for a push every `sync_interval_minutes`.
- **Sync from backup** (remote → local) — *⤵ Sync from backup* in Settings lists every backed-up
  repo; **Restore** clones it into a folder you pick and **auto-registers it as a source** so it
  shows up immediately. Already have the repo? It fetches non-destructively into
  `refs/remotes/gm-backup/*`.

Config lives in `~/.gitmanager/storage.json` (`0600`) — bucket/container names only, never secrets.

> **"… is not installed" when backing up?** The S3/Azure SDKs ship as engine
> dependencies, so a backend showing *"`@azure/storage-blob` is not installed — run
> `npm install`"* just means your `node_modules` is stale (deps added since your last
> install). Run `npm install` in the project (or reinstall the `gitm` CLI) and restart.

## Agent observe panel (opt-in)

Enable it in Settings. GitManager reads agent session **transcripts read-only**, discovers
running sessions, and binds each to its repo (via identity, from the session's `cwd`), branch,
and matching open PR — grouped by provider, updated live.

Supported out of the box (all observe-only, failing soft when not installed): **Claude Code**,
**Codex**, **Gemini CLI** (JSON/JSONL transcripts), **Antigravity** (base64-protobuf in its
`state.vscdb`), and **GitHub Copilot CLI**. Windows-style paths bind correctly from a Linux/WSL
engine via automatic `C:\…` ↔ `/mnt/c/…` translation.

## Configuration

Stored in SQLite (`config` table), editable in **Settings → Features**:

| Key | Default | Meaning |
| --- | --- | --- |
| `review_on_pr_open` | `true` | Run the Claude review automatically when a PR opens |
| `delete_head_on_merge` | `true` | Delete the head branch after a successful merge |
| `agent_observe_enabled` | `false` | Enable the read-only agent observe panel |
| `chat_enabled` | `false` | Enable the repo chat panel |
| `terminal_enabled` | `false` | Enable the built-in terminal tab on each repo view |
| `implement_enabled` | `false` | Allow Claude to implement PR changes (writes files) |
| `sync_enabled` | `false` | Enable scheduled backups to object storage |
| `sync_interval_minutes` | `10` | Interval for scheduled backups when enabled |

Environment overrides: `GITMANAGER_PORT` (default `4317`), `GITMANAGER_HOME` (default
`~/.gitmanager`), `GITMANAGER_CLAUDE_BIN` (default `claude`).

## Development

```bash
npm run dev        # engine with hot reload (tsx watch) on :4317
npm run dev:ui     # Vite dev server on :5173, proxying /api and /ws to the engine
npm test           # engine test suite (vitest)
```

In dev, give the Vite server the token via `VITE_GM_TOKEN=$(cat ~/.gitmanager/token)` or
`localStorage.gm_token`. In production the engine injects it automatically.

## Project layout

```
packages/
  engine/   Fastify daemon: git, db, identity, scan, merge, review, agents, storage, routes, ws
  ui/       React + Vite SPA: sidebar, repo view, PR view, agent panel, settings
  desktop/  Electron shell: spawns the engine, owns the native window, auto-update (see docs/desktop.md)
```

## Non-goals (v1)

Local-first (remotes are opt-in, GitHub-only). Simple branch-and-merge (no squash/rebase-on-merge).
Observe-only agents (control seams exist but are stubbed). No conflict-resolution editor.
