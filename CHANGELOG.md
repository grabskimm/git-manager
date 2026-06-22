# Changelog

All notable changes to GitManager are documented here, generated from Conventional Commits by semantic-release. Each version mirrors its GitHub Release notes.

# [1.1.0](https://github.com/grabskimm/git-manager/compare/v1.0.1...v1.1.0) (2026-06-22)


### Bug Fixes

* **desktop:** macOS update offers manual download (unsigned can't self-install) ([01d0f73](https://github.com/grabskimm/git-manager/commit/01d0f73c9174b6a0adc3e8bab430b0139812d0b5))


### Features

* **ui:** agents-first sidebar, collapsible agent groups, review model picker ([ccadf8c](https://github.com/grabskimm/git-manager/commit/ccadf8c572acfb762314fad1d9afd4ce5ecd5272))

## [1.0.1](https://github.com/grabskimm/git-manager/compare/v1.0.0...v1.0.1) (2026-06-22)


### Bug Fixes

* **ci:** skip PR packaging validation for docs/script-only changes ([2dc6bde](https://github.com/grabskimm/git-manager/commit/2dc6bde64650a302b967c47cb5578dcdb879e8b2))

# 1.0.0 (2026-06-22)


### Bug Fixes

* **ci:** fully disable mac signing without a cert; token-aware installers ([2ea99e0](https://github.com/grabskimm/git-manager/commit/2ea99e06d9585b1ce924fc06ab12aa0ac835ee86))
* **ci:** publish installers to the release (perms) and skip ad-hoc mac signing ([fb260b5](https://github.com/grabskimm/git-manager/commit/fb260b59403e207e19e959cb494b96e39560a004))
* claude review findings ([877dc92](https://github.com/grabskimm/git-manager/commit/877dc92e49553ea2682242ed28c5c3f5dc276b5a))
* **desktop:** force modern node-gyp so node-pty rebuilds on Windows ([d9a9056](https://github.com/grabskimm/git-manager/commit/d9a905658ad6e1f180e765ac8960c32cf05a4fdb))
* **desktop:** give the app a self-contained node_modules for packaging ([148773d](https://github.com/grabskimm/git-manager/commit/148773db10551c71f9839575afbba856eb113c81)), closes [electron-builder#7103](https://github.com/electron-builder/issues/7103) [#6448](https://github.com/grabskimm/git-manager/issues/6448)
* **desktop:** green the CI matrix + address review feedback ([555089d](https://github.com/grabskimm/git-manager/commit/555089daf0528da99c036b8a7475dcd8be0647fb))
* **desktop:** make local packaging stage deps like CI ([6937eeb](https://github.com/grabskimm/git-manager/commit/6937eebef99ec9cdc4c53d3a6b04e2fa207ceb67))
* **desktop:** pin Electron version so electron-builder works in the workspace ([4dba04c](https://github.com/grabskimm/git-manager/commit/4dba04c3ed312ebfff76c60d8fa124127250cc45))
* **desktop:** stop recompiling node-pty for Electron (fixes build hang) ([2c9f3b5](https://github.com/grabskimm/git-manager/commit/2c9f3b5e900a95382fa0f91061af809157bb51a5))
* **desktop:** surface updater errors and harden the fatal screen ([4c29251](https://github.com/grabskimm/git-manager/commit/4c2925198f22c48fc7de3c2581b0d0176102c225))
* **forge:** handle a diverged remote branch when opening a remote PR ([2869006](https://github.com/grabskimm/git-manager/commit/2869006ce6a1d053972a6f6c9ac1134176f96e4f))
* **review:** address all Copilot and Claude review comments on PR [#3](https://github.com/grabskimm/git-manager/issues/3) ([b6d04f9](https://github.com/grabskimm/git-manager/commit/b6d04f96df518544184167c309a9d24a50f0cac9))
* **review:** address second Copilot review round on PR [#3](https://github.com/grabskimm/git-manager/issues/3) ([138a943](https://github.com/grabskimm/git-manager/commit/138a94383d529e5630ec2345754dd4485623025d))
* **security:** pin Host header (anti DNS-rebinding), add CSP, gate terminal ([0421dcc](https://github.com/grabskimm/git-manager/commit/0421dcc589c5272b6b03dd48c4f781ca8be3014e))
* **security:** validate repo ids/refs and contain storage paths ([55c67c9](https://github.com/grabskimm/git-manager/commit/55c67c9ae603fd96331d86edcb29ca8944071680))
* **storage:** report missing cloud SDK accurately (not as an auth error) ([281aa15](https://github.com/grabskimm/git-manager/commit/281aa155b34688345c42a2ee1535879d97e787ea))
* **sync:** readiness now verifies write access, not just reachability ([8ee91b6](https://github.com/grabskimm/git-manager/commit/8ee91b623ad8759e927721554828e5d1d8765823))
* **sync:** stop Azure backup from hanging silently ([6e05999](https://github.com/grabskimm/git-manager/commit/6e05999a852c4e1fb27b024214dd17f411af994b))
* **sync:** surface the real Azure backup error instead of swallowing it ([ba011e7](https://github.com/grabskimm/git-manager/commit/ba011e7b9ed1a0bc6c77329e17caaee90f8d4bd0))
* **ui:** blank page when sidebar collapsed (hover mode) ([2a9db76](https://github.com/grabskimm/git-manager/commit/2a9db76abafac03cccba5f6154ea2e27912aefb6))
* **ui:** sanitize diff and file HTML before injecting it ([495de5e](https://github.com/grabskimm/git-manager/commit/495de5e4c5a6ea869860cf724c4c3684274ff476))
* update packages ([e9a5695](https://github.com/grabskimm/git-manager/commit/e9a5695aefdd9d98bd808c86f38c8c148121d42c))


### Features

* add install.sh / install.ps1 to install from releases ([86c5795](https://github.com/grabskimm/git-manager/commit/86c57957badba15be3be63ebc1ce59a93ec45727))
* **desktop:** add app icon/logo and fix local-dev native ABI ([983d647](https://github.com/grabskimm/git-manager/commit/983d647aa79c771c1261f0236049942a74b1b712))
* **desktop:** drop the green dot, use the GitManager logo as the icon ([80f054c](https://github.com/grabskimm/git-manager/commit/80f054c010a1f5d52ebaca552f87341359c2770b))
* **desktop:** icon everywhere, About settings, arm64-only mac, dev ABI fix ([b1f4089](https://github.com/grabskimm/git-manager/commit/b1f408996afdab47bd3c82cf8c41681c9608b3a0))
* **desktop:** ship GitManager as a cross-platform desktop app ([25c8cf8](https://github.com/grabskimm/git-manager/commit/25c8cf8f619181becc065bfda7d678c76d0f3763))
* repo chat panel with cross-repo metadata context ([94af5fa](https://github.com/grabskimm/git-manager/commit/94af5fa91013401635c774de5b0b820419606047))
* show the real git user name instead of generic "user" ([d3444c7](https://github.com/grabskimm/git-manager/commit/d3444c7669a3a76dcf2dbd25d5d457d14662d869))
* sync-from-backup restore UI with auto source registration ([e97835f](https://github.com/grabskimm/git-manager/commit/e97835f9a889c8d3c64e54683e1b95bb426a28d9))
* **ui:** hover-peek sidebars, fit-to-screen fix, chat/agents polish ([27ae34e](https://github.com/grabskimm/git-manager/commit/27ae34e84ab3da020effcb3dfb65861de8a1458d))
* **ui:** makeover chat & agents — tabbed sidebar, friendlier chat ([7da4d4d](https://github.com/grabskimm/git-manager/commit/7da4d4d8c92575c2b11f6470b5a54c202acf885a))
* v1 UI polish — collapsible sidebar, create-repo, code fit, README ([b54e083](https://github.com/grabskimm/git-manager/commit/b54e0830e80a75685c1afc2f585a252a6a856aa7))
