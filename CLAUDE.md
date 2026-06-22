# CLAUDE.md

Guidance for working in this repository. GitManager is a **local-first,
GitHub-like UI over multiple local git repositories** — local PRs, automatic
AI (Claude) review, agent observation, a built-in terminal, and optional
object-storage backup. Everything runs on loopback; no server, no telemetry.

## Layout

npm-workspaces monorepo, ESM throughout, Node ≥ 20.

- `packages/engine` — Fastify 5 + better-sqlite3 backend. Runs all `git`
  operations as subprocesses, serves the SPA, and exposes the loopback API +
  WebSockets. Entry point is `src/cli.ts` (`gitm` / `gitmanager` bin).
- `packages/ui` — React + Vite SPA (React Router). Talks to the engine over
  loopback HTTP + a WebSocket. `src/types.ts` mirrors the engine's domain types
  by hand — keep them in sync.
- `packages/desktop` — Electron shell (Windows/macOS/Linux). A thin
  shell + lifecycle manager + updater: `src/main.ts` picks a free loopback port,
  spawns the **same** engine as a child on Electron's bundled Node
  (`ELECTRON_RUN_AS_NODE`), waits on `/healthz`, then loads the UI in a hardened
  webview. The engine and UI run **unchanged** — feature parity is automatic, so
  don't fork behaviour into the desktop layer. See `docs/desktop.md`.

### Engine modules worth knowing

- `server.ts` — wires routes, static SPA hosting, `WsHub`, `TerminalServer`,
  `AgentManager`, `SyncScheduler`. Registers the security floor first.
- `security.ts` — the auth/anti-rebinding floor (see below).
- `git.ts` — the **only** place that shells out to `git`. Typed wrappers
  (`runGit` never throws; `git()` throws on nonzero). Never reimplement git
  semantics elsewhere.
- `merge.ts` — merge engine: a throwaway **detached worktree** in `os.tmpdir()`
  so user checkouts are never disturbed; FF when possible, else a merge commit;
  aborts cleanly on conflict. System git does the work.
- `identity.ts` — stable repo id: `.gitmanager` marker → earliest root commit →
  minted `gm-<uuid>`. Ids from the checked-in marker are **untrusted** and must
  pass `isValidRepoId` (they double as storage path segments — guards against
  `../` traversal).
- `review.ts` / `implement.ts` / `chat.ts` — Claude integration (review on PR
  open, "implement this review", chat). All run `claude` via `claudeProcess.ts`.
- `agents/` — read-only observation of agent transcripts (Claude Code, Copilot
  CLI, Antigravity, generic JSONL). `manager.ts` orchestrates + persists.
- `storage/` — backup as git bundles to FS / S3 / R2 (via wrangler) / Azure
  Blob. `sync.ts` is push/pull/manifest; `backend.ts` defines the interface and
  key layout; `index.ts` is the backend factory (throws on unknown id).
- `db.ts` — SQLite schema + additive migrations + seeded default config.

### State directory

All durable state lives under `~/.gitmanager` (override with `GITMANAGER_HOME`,
which tests use for isolation):
- `token` — loopback auth token, mode `0600`, 64 hex chars, auto-generated.
- `gitmanager.db` — SQLite (WAL). Tables: `source_dirs`, `repos`, `prs`,
  `pr_thread`, `agent_sessions`, `config`.
- `storage.json` — backup backend config (no secrets; creds come from provider
  logins: `aws sso login` / `wrangler login` / `az login`).

## Commands

Run from the repo root.

```bash
npm install
npm run dev          # engine in watch mode (tsx)
npm run dev:ui       # Vite dev server (proxies /api + /ws to the engine)
npm run build        # build ui then engine; engine bundles ui into dist/ui
npm test             # engine vitest suite (the only test suite)
npm run typecheck    # tsc --noEmit for BOTH packages
npm start            # run the built engine (node dist/cli.js)

npm run desktop      # build engine+ui, then launch the Electron app
npm run desktop:dist # build local installers -> packages/desktop/release/
```

The `gitm` CLI subcommands (`gitm pr create`, `gitm sync push`, etc.) talk to a
**running** engine over loopback using the token — start the engine first.

### Desktop native modules — do not regress

The engine runs on Electron's bundled Node, so its native modules must match the
**Electron ABI**, not the system Node ABI:

- **`better-sqlite3`** is a V8 addon — it **must** be rebuilt for Electron
  (`npm run desktop` and CI do this; `postdesktop` restores the system-Node build
  afterward so `npm test` / `npm start` keep working).
- **`node-pty`** is **N-API** (ABI-stable) — it must **not** be rebuilt for
  Electron. Recompiling it under `@electron/rebuild` deadlocks the build, so
  `electron-builder.yml` sets `npmRebuild: false` and we rebuild *only*
  better-sqlite3 explicitly. Leave node-pty's prebuilt binary alone.

Packaging stages a self-contained, de-symlinked copy of the engine under
`packages/desktop` (asar can't follow the workspace symlink) — `scripts/dist.mjs`
locally, an explicit CI step otherwise.

## Security model — do not regress

This is the core invariant of the project. The engine handles untrusted repos
and runs `git merge` + launches Claude, so the security floor in `security.ts`
is enforced on the very first `onRequest` hook:

- **Bind 127.0.0.1 only — never 0.0.0.0.** Loopback only.
- **Host allow-list on every request** (anti DNS-rebinding) — pinned to the
  loopback authority `host:port`.
- **Bearer token** on every `/api` call; constant-time compare (`safeEqual`
  hashes both inputs so length never leaks).
- **Origin allow-list** on state-changing requests (anti-CSRF). Safe GET/HEAD
  stay token-only.
- **WebSocket upgrades** (`/ws`, `/ws/terminal`) enforce Origin + token. The
  token rides the `Sec-WebSocket-Protocol` header (browsers can't set
  Authorization on a WS handshake; keeps it out of URLs/logs). A catch-all in
  `server.ts` 404s any unclaimed upgrade path so sockets don't leak.
- Static UI is served without token auth (the token is injected into the HTML),
  but is still Host-pinned so a rebinding origin can't read it out.
- **No telemetry, no network calls except localhost** — unless the user opts
  into remote PRs (`gh`) or backup (cloud SDKs).
- The terminal, chat, implement, and agent-observe features are **off by
  default** (`config` table) and gated.

When touching auth, the WS handshake, path handling, or anything that takes a
repo-controlled value (marker ids, refs, paths), assume hostile input and keep
the relevant `security.test.ts` / `identity.test.ts` coverage green.

## Conventions

- Match the surrounding style: typed, fail-soft (missing `claude`, missing
  wrangler, locked SQLite, bad repos all degrade gracefully rather than
  blocking). Comments explain *why*, not *what*.
- `runGit` never throws; check `.code`. Use `git()` only when a throw is wanted.
- Backup `PushResult.backend` is the human-readable `backend.label`, not the
  config id — keep it consistent across success and failure paths.
- Tests are vitest in `packages/engine/test`. Isolate via `GITMANAGER_HOME`
  (see `test/helpers.ts`). Run `npm test` + `npm run typecheck` before pushing.

## Git workflow

- Do **not** create PRs unless explicitly asked.
- Do **not** put any model identifier in commits, PR bodies, or code — chat only.
- Push with `git push -u origin <branch>`; retry network failures with backoff.
- **Conventional Commits** drive releases: semantic-release runs on every push to
  `main` (`.github/workflows/release.yml` + `.releaserc.json`), computing the next
  version from commit types (`feat` → minor, `fix` → patch, `feat!`/`BREAKING
  CHANGE` → major; `chore`/`docs`/`ci`/`refactor` → no release). It tags `v<version>`,
  and the tag triggers `desktop-release.yml` to build + publish the installers and
  auto-update manifests. (npm publishing of `@git-manager/engine` is temporarily
  disabled — see the note in `release.yml`.) Write commit subjects accordingly.
