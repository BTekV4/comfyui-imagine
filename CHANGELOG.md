# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project's
versions follow [semantic versioning](https://semver.org/).

## 0.3.1 — 2026-11-18

### Added

- **Story shots in the page's language.** The director writes a short caption
  for each shot in the page's language in the same planning step; the queue
  tile and the shot's Details show it, while the English beat still goes to the
  video model (it stays under «Show the prompt sent to the model»). When the
  plan comes back without captions, one short request fills them in without
  delaying the clips.
- **The open-studio banner can be hidden** for the whole studio, and comes
  back when the listening address or the login changes. Settings → Access can
  show it again.

### Changed

- Speech synthesis and voice change no longer have a fixed deadline: they stop
  only when the service stays silent for 10 minutes, or on Cancel.

- **Packages carry only `yaml`.** The server, the MCP server and every plugin
  are self-contained bundles: `react`, `react-dom` (and `scheduler`), `immer`
  and `fflate` are build-time packages and are no longer installed with a
  release. The tarball's `node_modules` goes from 11 MB to 1.3 MB (the tarball
  from 6.5 MB to 5.0 MB) and the portable zips are 1.8 MB smaller; the AppImage
  and the Windows installer already excluded `node_modules`, so they do not
  change.
- **ffmpeg is pinned, and every download is checked.** The Linux build is
  johnvansickle 7.0.2 and the Windows one is a fixed BtbN `autobuild-…`
  release, each with the SHA-256 of the exact bytes in
  `scripts/package-portable.sh`; the fallbacks (ffbinaries 6.1, Linux and
  Windows) are pinned the same way. A download that does not match is retried
  and then refused, never packaged. The AppImage and the Windows installer take
  those same binaries. The comment at the top of the pins says how to bump one.

### Fixed

- **H3 chain videos in 9:16 at 720p failed** with "width and height must be
  positive multiples of 32": the frame is now snapped to the 32 px grid
  (720x1280 becomes 736x1312), and a graph rejected by ComfyUI is no longer
  retried.
- **A local photo edit names one change and gives up after two redraws.**
  The photo edit redraws the whole picture, so a grounded prompt that also
  listed the clothing, the body and the background was read as a description
  of the scene. Two "remove the extra arm" runs on 2026-11-17 rewrote the whole
  photo and left the arm, and each retry started from the failed output. A
  local edit is now worded as the change only, closed by one fixed sentence
  that asks for the rest to stay; a correction starts from the photo the failed
  run started from; and after two failed redraws no third one is queued: the
  studio points to «Remove object» (IOPaint), which paints the part out and
  leaves the rest identical. The remove-object template asks for one thing too.
- `scripts/check-windows.ps1` failed once on the upgraded install (2026-11-17)
  on a blank screenshot: the window's DOM had rendered but the surface was
  captured before its first paint. The self-test now waits for a painted frame,
  looks at the pixels instead of trusting the file size, and retries a blank
  capture before keeping the last one for the failure report.

## 0.3.0 — 2026-11-17

### Added

- **A Windows installer.** `Imagine-<version>-windows-x64-setup.exe` installs
  Imagine for the user who runs it: per user, no administrator prompt, no folder
  to choose, icons on the Desktop and in the Start menu, an entry in *Installed
  apps* whose uninstall keeps `%APPDATA%\Imagine`, and an update that replaces
  the program in place. ffmpeg and ffprobe are inside the package
  (`resources\ffmpeg`) and first on `PATH`; Node is the one Electron carries.
  The installer is **unsigned** for now, so the first launch may go through
  SmartScreen (*More info → Run anyway*).
- `scripts/check-windows.ps1`: installs the installer silently, starts the
  installed program, checks the window and the packaged ffmpeg, edits a
  workflow, restarts the studio, launches it twice, closes the window (no server
  left), uninstalls (data kept) and installs the next version over the previous
  one. CI runs it on `windows-latest` on every push; the release runs it before
  attaching the file.
- **Log out**, and sessions that end: the login cookie lasts 30 days and is
  renewed while the studio is used, and saving a new password signs out every
  other browser. Existing sessions are asked for the password once after the
  update.
- A banner when the studio listens beyond this machine with the password off.
- A **Modified** label on the bundled workflows changed in the app, gone again
  after **Restore default**.
- `SECURITY.md`: how to report a problem, what the login protects, and the
  loopback bypass.

### Changed

- State-changing requests from another site are refused (`Origin`, `Referer`,
  `Sec-Fetch-Site`), and the studio sends a Content Security Policy,
  `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy`.
- The user's data files (likes, tags, Instagram records, custom workflows,
  prompts, notes, plugin state) are written readable by their owner only.
- React 19 and Vite 8; the web bundle is about 4% larger.
- `/api/restart` stops the studio the graceful way on every platform.
- CI: read-only token, a timeout on every job, a secret scan (gitleaks), every
  action on Node 24, and monthly Dependabot updates.

### Fixed

- Replacing a cover twice within the same millisecond (seen on Windows) no
  longer leaves the old file behind.

## 0.2.0 — 2026-11-17

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
- **The bundled graphs can be changed without losing the updates.** The first
  edit to a workflow from **Settings → Workflow** copies that one file into the
  data folder (`workflows/<the same relative path>`) and writes there; the copy
  wins from then on, and **Restore default** on the workflow's card deletes it,
  so the program's graph is in use again. Every other installation (service,
  container, tarball, portable zip) keeps writing the file itself, as before.
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
