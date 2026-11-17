# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project's
versions follow [semantic versioning](https://semver.org/).

## Unreleased

### Added

- **Imagine is an app.** The Linux AppImage is no longer a script that copies the
  studio into `~/.local/share/imagine` on the first start and opens a browser: it
  is an **Electron window** with the studio inside — its own icon and menu, one
  instance at a time (a second launch brings the open window to the front),
  external links in the system browser, and the failures of the first minute in
  the window, with **Try again**. Closing the window stops the studio's server;
  if the server dies while the window is open, the window says so.
- **The program and the data are separate.** The program (server, page, graphs,
  language packs) stays inside the read-only AppImage and is replaced whole by an
  update; `config.yaml`, the media, the projects and the installed plugins live
  in the user's folder, which the new version finds again. A machine that used
  the previous AppImage keeps its folder, so an update finds everything where it
  was.
- A log in the data folder (`logs/imagine.log`, rotated at 5 MB) and **File →
  Open log folder** / **Open data folder** in the menu.
- `scripts/check-appimage.sh`: starts the AppImage on a virtual screen and checks
  that the window really loaded the studio (address, title, what `#root` holds),
  that a second launch does not start a second studio, and that closing the
  window leaves no server process. CI runs it on every push; the release runs it
  before attaching the file.

### Changed

- The server reads `IMAGINE_PROGRAM_DIR`, `IMAGINE_PORT` and `IMAGINE_HOST`
  (`server/src/boot-env.ts`): a packaged app names its read-only program folder
  and the free loopback port it reserved, without rewriting `config.yaml` on
  every start. Every other installation boots exactly as before.
- `scripts/package-appimage.sh` is gone: `scripts/package-electron.sh` builds the
  AppImage with electron-builder, and the same tree is what a Windows NSIS
  installer will pack (`electron-builder.yml`; the target is one line away and
  deliberately off).

## 0.1.2 — 2026-11-16

### Added

- **An AppImage for Linux** — `Imagine-<version>-linux-x64.AppImage`: one file,
  `chmod +x`, double-click. Mounted read-only, so on the first start it copies
  itself into `~/.local/share/imagine` (`IMAGINE_DATA`) and works from there; a
  second launch reopens the page, and `IMAGINE_PORT` puts two copies side by side.
- The AppImage is built by the same script in CI, on every push, and attached to
  every release.

### Fixed

- A package built from a `dist/` older than `package.json` shipped the previous
  version inside (0.1.1 saying 0.1.0): the packaging script now rebuilds when the
  manifest is newer.
- The AppImage launcher reads its port from `config.yaml` instead of assuming
  3090, which made it believe a copy was already running whenever another
  installation used that port.

## 0.1.1 — 2026-11-16

The release that does not need a terminal.

### Added

- **A portable package for Linux** — `Imagine-<version>-linux-x64.zip`: the
  studio with **Node 24** and a static **ffmpeg** inside, plus `Imagine.sh`.
  Extract it anywhere and run it; the launcher opens the browser when the page
  answers, and a second launch reopens the page instead of starting a second
  copy. Everything the studio keeps (projects, thumbnails, plugins, language
  packs, media) lands in `data/` beside the app, so the folder is
  self-contained.
- **No configuration to write on a first run.** With no `config.yaml` the
  server writes one from `config.example.yaml` (ComfyUI on `127.0.0.1:8188`, a
  local text endpoint, one model), and the home page's first-run card says what
  is still missing and how to fix it. Before, the boot died on the missing file
  and the only way in was `install.sh` asking three questions in a terminal.
- **CI builds and boots the portable package** on every push, so a package that
  cannot start does not reach a release.

### Changed

- The release notes are a table by system: download, extract, double-click.

## 0.1.0 — 2026-11-16

The first release: from here the studio is something to download rather than a
repository to build.

### Added

- **Releases with a prebuilt tarball.** `comfyui-imagine-<version>.tar.gz`
  carries the built server, the MCP server, the page, the plugin bundles and the
  five runtime packages: installing needs no `npm install` and no build step.
  Attached by the `Release` workflow, with a SHA-256 digest beside it.
- **`install.sh`.** Checks Node 24+, `ffmpeg`/`ffprobe` and the ComfyUI address,
  asks three questions, writes `config.yaml`, and can install the systemd unit.
  `--check` only runs the checks.
- **The first-run card.** `GET /setup-status` reports ComfyUI (address, version,
  devices), ffmpeg, the configured model, the output folder and the Node the
  studio is running on; the home page draws one row per failure with the command
  that fixes it, and nothing when everything is in place.
- **CI and a release workflow.** Typecheck, the whole test suite and the build
  on every push and pull request; a tag builds the tarball and publishes it.
- **Docker.** A multi-stage `Dockerfile` and a `docker-compose.yml` for the
  Node process alone, with ComfyUI outside the container where its GPU is.

### Changed

- **README.** A `Start here` section with the downloads table (weights by kind
  of work, so a 12 GB card knows what it can and cannot do), three documented
  ways in (tarball, Docker, source), and Configuration / Workflows / Templates
  moved to `docs/`.
- **The media folder is created at boot** instead of failing the first job with
  `ENOENT` on a fresh installation.
- **The version is stamped into the bundle by the build** (`__IMAGINE_VERSION__`),
  so a deployment's folder layout cannot hide it.
- The studio's home is one grid for flows, models and your uploaded workflows,
  with filter chips and an address for every card; adding a workflow is a tile
  of that grid, not a strip under it.
- `plugins/instagram`: a refused comment pass is reported as a failure instead
  of "zero comments read".
- The Plugins page scrolls.

### Fixed

- The first-run card no longer reads `../package.json`: it is the build's own
  version.
