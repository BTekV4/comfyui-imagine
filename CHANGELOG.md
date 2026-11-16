# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project's
versions follow [semantic versioning](https://semver.org/).

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
