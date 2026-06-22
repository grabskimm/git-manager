# GitManager landing site

A single static page that markets GitManager. **No build step** — hand-written
HTML/CSS/JS uploaded to GitHub Pages as-is by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml).

```
site/
  index.html      # all the markup + copy
  styles.css      # all styling (dark by default, light via toggle)
  main.js         # theme toggle, copy buttons, scroll reveal (progressive enhancement)
  assets/
    logo.svg      # favicon + brand mark (from packages/ui/public/favicon.svg)
    logo.png      # og:image + apple-touch-icon (from packages/desktop/build/logo.png)
```

## One-time setup (required once)

After this lands on `main`, a repo admin must point Pages at the workflow:

> **Settings → Pages → Build and deployment → Source → "GitHub Actions"**

The workflow then deploys on every push to `main` that touches `site/**`, and on
manual **Run workflow** (`workflow_dispatch`). The live URL is
`https://grabskimm.github.io/git-manager/`.

## Editing copy

- **All copy lives in `index.html`** — edit it directly, no templating.
- Keep every claim grounded in the repo's `README.md` / `CLAUDE.md`. Don't invent
  install commands, features, or versions; if a fact isn't in the repo, leave a
  `TODO:` comment instead of guessing.
- The **version** in the footer (`v1.1.1`) is maintained by hand — bump it when a
  new release ships (or replace it with whatever the current release is).
- **Hero visual:** the hero shows the real app screenshot (`assets/screenshot.png`,
  the `.shot` `<img>`) with a compact `gitm` terminal demo (`.terminal`) beneath it.
  To replace the screenshot, swap the file at `assets/screenshot.png` and keep the
  `width`/`height` on the `<img>` in sync with the new image to avoid layout shift.
  The PNG is large (~3024px); compressing or downscaling it to ~1760px would help
  page performance (no image tooling was available to do this automatically).

## Design notes

- System font stack + a monospace accent — no external/blocking web fonts.
- Dark mode is the default; the header toggle persists the choice in `localStorage`
  and the no-flash script in `<head>` applies it before first paint.
- Motion (hover, scroll reveal) is disabled under `prefers-reduced-motion`.
- Target: single page, < 100 KB excluding images, Lighthouse 100s.
