# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project's
versions follow [semantic versioning](https://semver.org/).

## Unreleased

### Fixed

- **The media panel's tiles stayed square with hundreds of files.** The grid
  rows were sized by `align-items: stretch`, so as soon as the tiles outgrew
  the panel every row came out as tall as the gap and the pictures were
  "squashed" strips; the rows now follow each tile's own height, and the grid
  scrolls inside the panel, whose height stays inside the window. The list is
  drawn a page at a time (60 tiles, grown by the scroll or by "Show more")
  instead of laying out the whole gallery before the first tile is seen.

### Added

- **One place to pick what to send.** The composer's "+" opens a media panel:
  **Creations** (what the studio drew, newest first) and **Uploads** (what came
  in through the upload route), both searched with the Media page's own index,
  a click per file, and a removable thumbnail above the field for each one.
  **Upload media** takes files from the disk or a drop on the panel. On a phone
  the panel is a sheet and the two lists become one row of tabs.
- `MAX_STAGED_FILES` in `shared/imagine-chat.ts`: the composer's ceiling and
  the number of runs one written line may queue, from one number.

## 0.4.1 — 2026-11-21

The release where the chat keeps to what was asked: every run is built from a
spec, the result is checked against it and against the source, and the reply
says what the check saw. The chat reads inside a graph, but the LoRAs stay the
owner's.

### Added

- **The agent reads inside a graph.** `inspect_workflow` and the instruction
  carry each LoRA with its weight and the word that switches it on, the
  sampler values, the frame and whether the graph takes a picture in.
  `generate_image` and `run_card` take `tweaks`, values for one run, checked
  like a settings edit.
- **A spec for every run.** Generate, edit and card runs say what changes,
  what has to stay (framing, visible text, subjects, style, format) and how
  far a "more" goes: one step.
- **A check against the source.** An edit is compared with its source by the
  vision pass: what stayed, what went missing, what was added, which text is
  there.
- **One state per picture.** A "more X" starts from the last accepted state
  with the smallest change, failed combinations are remembered and not run
  again, and a local fault is fixed on its own spot.
- **A LoRA catalog the owner writes.** Settings list each LoRA's purpose,
  trigger word and weight; the chat reads it, the repository carries none.
- **A style reference on a generation graph.** `dropRefBranch` puts the
  sampler back on the graph's own text encode when no reference is given.
- `run_card` takes a `count`, and a batch speaks once, as its files land.

### Changed

- The LoRAs are the owner's: `tweaks` refuse any LoRA weight, file or switch.
- A run never adds nudity or explicit content the line did not ask for.
- The reply is held to the vision pass: what the check reported is said, never
  denied. At most three attempts per request, a repeated result counts as a
  failure, and the reply says what is still missing.
- A name the user wrote is kept whole in the prompt.
- A turn gets the run budget its line asks for, up to ten pictures.

### Fixed

- The README install line reads the latest version instead of a fixed tarball.
- A run joins its project as soon as it is queued, so an interrupted turn no
  longer loses a batch.
- The style comes from the references and the words, not from the word "foto".

## 0.4.0 — 2026-11-20

The release where the chat does the work itself: it calls the studio's tools,
checks what they made against the request, and says what is still running. The
vision pass stops guessing numbers the file already knows, and a requested
length is the length that is rendered.

### Added

- **An agent chat with tools, not one fixed reading.** A project's chat can
  queue a still, edit one, remove a mark, look at a file, read the project and
  check a run; it also renders a clip from a picture, a continuation, a loop, a
  story, music, speech, a voice change, an upscale and a personal card. The
  exact same paths the page uses are behind the tools, so an agent run is an
  ordinary job on the board and can be cancelled from the gallery.
- **The agent reaches every studio action.** `run_action` carries object swap,
  character swap, recreate, relight, compose, background removal, redo, resume,
  `scanFrame`, regenerate and personal cards, with the action's own fields as
  the page sends them. Dedicated tools exist where one reads better.
- **Expensive work asks first.** A clip longer than fifteen seconds, a story,
  music, a montage, a personal card and a 4K upscale stop before they start:
  the turn ends with a Yes/No card, nothing is queued and nothing is cancelled
  until the answer, and the yes resumes the same turn. `cancel_job` only ever
  proposes; the user's yes is what stops the run. The limit is shown in
  Settings.
- **The agent looks before it claims.** A finished run returns each file with
  its real width, height, ratio and duration, and a `mismatch` when the shape
  or the length is not what was asked. The `look` tool answers one targeted
  question and carries the file's measured numbers.
- **A repeatable bench for the agent chat.** `scripts/agent-bench.mjs` starts a
  studio of its own (port 3091, its own data root, media folder, settings and
  IOPaint plugin), records the model's tool calls through a small proxy, draws
  neutral fixtures, runs fifteen Italian requests against a real model and
  ComfyUI, and writes a Markdown and a JSON report with the real measurements,
  the reply language, timings, errors and automatic checks.
- **Writing, a logo and a watermark go straight to the masked eraser.** The
  written lane recognises the request and runs «Remove object» (IOPaint's LaMa)
  instead of a remix: nothing else redraws the photo around it. The zone is
  found by the vision model, and the mask is grown and softened so the fill does
  not leave the halo a hard edge leaves. It is a host edit, not a graph: no job
  is queued.
- **A named thing becomes the zone.** "Make the leather bag dark" is grounded
  on the photo, with the file's own description, so the word the user used
  ("la borsa") is matched to what is really there ("the red handbag") before a
  box is drawn. When a SAM 3 mask is available the zone is cut along the
  object's own outline, not the rectangle around it.
- **A track can be laid over a clip** (`addAudio`, chat and MCP): the clip
  decides the length, the picture is copied and never re-rendered, and the
  original files stay.
- **MCP audio tools**: `imagine_generate_music`, `imagine_speak`,
  `imagine_change_voice` and `imagine_add_audio`, with the same actions the
  chat queues.

### Changed

- **Zones follow the object, not its box.** A grounded edit or erasure cuts the
  SAM 3 mask when the studio can segment the thing, so a rectangle's background
  is no longer regenerated around it. A rectangle the user painted stays a
  rectangle.
- **Durations are real.** A length off the video ladder takes the next rung up,
  a chained video renders at the frame its ladder step asks for, and one past
  the longest single clip runs as a chain at the length asked for instead of
  falling back to ten seconds. A music request keeps its length too: the graph's
  `max_duration` is only a cap, so the requested length is written on the empty
  latent that actually fixes the audio.
- **The vision pass is sober.** Its instruction carries the file's measured
  width, height, ratio and duration and says those are the only truth for size
  and shape. It is told not to estimate dimensions, counts, colours, written
  text, marks or objects it cannot see plainly, and to say when something is not
  clearly visible. The description stays; the invented numbers go.
- **An image edit keeps the photo's own shape.** The Krea 2 edit graphs measure
  the photo they are given; the written lane no longer sends a studio canvas for
  a remix, so a 4:5 photo no longer comes back on a studio ratio with its
  composition cropped. A ratio the user really names ("falla quadrata") still
  travels, and a resolution without a shape keeps the source's shape.
- **The prompt is the user's words; the studio's orders are arguments.** The
  drawn prompt keeps the subject, the adjectives and the language the user
  wrote, and leaves out "modifica", "9:16", "1080p", "tre foto", "16 secondi"
  and the talk around them. Those choices go in `aspect`, `resolution`, `count`
  and `seconds`; one the user made and the model drops is recovered from the
  line, and one the model invents is refused.
- **The agent's reply is in the interface's language.** Every tool result says
  which language the reply is written in; a reply in another language is sent
  back once, with no tools, to be rewritten. A reply carrying a foreign script
  is caught even when the rest of the sentence is Italian.
- **The written lane carries the composer's controls.** A sentence can ask for
  the «Quality» pill (`quality: "high"` for a photo, `speed: "slow"` for a
  clip), an upscale target (`upscaleTo`, on the ladder of the file's kind), and
  a precise edit's zone (`region`, fractions of the photo, the rest left
  untouched). Until now those choices only existed as buttons.
- **Personal cards are runnable from the chat.** The workflow inventory carries
  every uploaded card with its id, title, description and exposed inputs; a
  sentence runs one with `action: "custom"`, `customWorkflowId` and
  `customFields` keyed `<node>.<field>`, exactly as the MCP's `custom` action
  does. A configured entry that points at a card is shown by its title and
  description instead of the UUID.
- **Every workflow entry accepts a `description`** — when to use it, in one
  line — shown in Settings → Workflows and given to the written lane, which had
  been choosing a graph from its title alone. `config.example.yaml` describes
  all of them.
- **The graph second pass is given the node facts**: a combo's closed list (the
  LoRAs, checkpoints and models this installation really has), a number's
  bounds and step, and the pins that no longer resolve. A closed list is
  filtered by the sentence, and always keeps the value the input holds now.
- **The workflow gateway opens only on an explicit request.** A model that
  names a graph behind an ordinary request ("fammi una foto") no longer turns
  the sentence into a graph question, and a sentence that asks for a run *and*
  about a graph keeps its intents beside the proposal instead of losing them.
- **An edit that changed nothing is reported.** When a remix delivers the photo
  it started from, the job carries a notice saying so, instead of the same
  picture landing on the board with no word.

### Fixed

- **A music request keeps the length it asked for.** MiniMax Music 3's
  `max_duration` is a cap, not a fixed length, and the empty latent was linked
  to the encoder's own choice: a 30 s request came back 17.9 s or 21.9 s. The
  requested length is now written on the latent too; 15, 30 and 60 s render at
  15.02, 30.01 and 60.03 s.
- **The agent recovers a count and a length the model drops.** "Tre foto" and
  "un video di 16 secondi" were said in the reply and missing from the call;
  the studio now reads them from the user's line, as it already did for a
  ratio and a resolution. The length is also what drives the confirmation.
- **A translated prompt is replaced, not accepted.** A model that writes the
  drawing prompt in a language the user did not use gets the user's own line
  instead: the work runs, in the right words, instead of stopping to ask.
- **A run waiting for an install is never called "running".** The tool result
  says `setup-needed`, names the missing packs or models, and the reply points
  at the Install button. A run that ended in error says what failed, and an
  empty reply is never saved.
- **A graph this deployment does not configure is said in the chat**, before a
  job exists, instead of failing after the queue. A card whose graph does not
  load is reported the same way.
- **A change the node would refuse is refused by the plan**: a combo value off
  its closed list and a number outside its bounds are reported with the values
  that would work, and a measure is snapped to the node's own multiple.
- **The relight instruction is subject-neutral** and writes the provider the
  config defines, so a photo's person is not described by the pass that only
  has to change the light.
- **The ffmpeg download is bounded and has a second source**, and the
  production dependency tree is checked on every push, so a package cannot ship
  a binary or a dependency nobody checked.

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
