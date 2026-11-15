<p align="center">
  <img src="docs/assets/imagine-icon.svg" width="112" height="112" alt="Imagine logo">
</p>

<h1 align="center">ComfyUI Imagine</h1>

<p align="center">
  A local studio for ComfyUI: describe what you want, get images, edits and videos.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3B6CF6"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-%E2%89%A524-8E44F0">
  <img alt="Languages: English, Italian" src="https://img.shields.io/badge/languages-EN%20%7C%20IT-555">
</p>

<p align="center"><sub>An independent project for ComfyUI, not affiliated with or endorsed by Comfy Org.</sub></p>

<p align="center">
  <img src="docs/screenshots/home.jpg" alt="New generation: the composer and the action cards" width="900">
</p>

A chat that turns a sentence into the right graph, a queue that runs it, a
canvas and a gallery, and a set of ready-made recipes — image to video, character
and object swap, relighting, animated loops, music, voice, upscaling.

It is a single Node process plus a React interface. It talks to ComfyUI over its
HTTP API and to any OpenAI-compatible chat-completions endpoint for the text and
vision work. Nothing leaves your machine except the calls to the model endpoint
you configure.

The interface is written in English; other languages are installable packs, and
the repository ships Italian (see [Languages](#languages)).

## What it does

- **Chat that drives the graphs.** You describe what you want; the studio picks
  an action, stages the files you dropped in, and asks the text model to write
  the prompt for that specific graph.
- **Recipes, not single nodes.** "Recreate" reads a video with the vision
  model, redraws its opening frame and renders the clip again from it. "Edit
  object" tracks an object in a clip and changes, removes or adds it;
  "Character swap" puts the person of a photo in place of the clip's main one.
- **Long videos as one take, the way [Openjutsu](#acknowledgements) does it.**
  Past six seconds a clip is a chain of scenes of at most six seconds, rendered
  inside ComfyUI with the
  [MiniMax H3 Context Loop](https://github.com/ethanfel/ComfyUI-MiniMaxH3-Context-Loop)
  nodes: each scene starts from the last frames of the one before, every scene
  is saved as a checkpoint so a stopped run resumes where it was, and the vision
  model writes one prompt per scene. Make video, extend (up to 60 s), animated
  loops (the last scene lands back on the first frame) and both swaps work this
  way; the swaps render at 480p, 720p or 1080p.
- **A job queue that survives.** Long renders report progress, can be cancelled,
  and a music video left half-made is picked up again after a restart.
- **A photo viewer with tools.** Every picture opens with **Segments** (each
  object found, cut out, ready to edit or download), **Precise edit** with a
  brush, **Colors**, **Draw** and **Crop**, plus one-click remove background,
  make video and upscale.
- **Graphs as configuration.** Every action is an API-format ComfyUI graph plus a
  handful of node ids in `config.yaml`. Swap the model, keep the studio.
- **An MCP server.** `mcp/` exposes the studio's projects, files and jobs as
  typed tools for MCP clients (Claude Code and other agents). It is a separate
  process that talks to the studio only through its HTTP API — see
  [mcp/README.md](mcp/README.md).

## Screenshots

| | |
|---|---|
| ![A project: the chat on the left, its pictures and video on the canvas](docs/screenshots/project.jpg) | ![The canvas: a project's pictures and video side by side](docs/screenshots/canvas.jpg) |
| **Project** — the chat explains each choice; results land on the canvas | **Canvas** — arrange, compare and reuse what the project made |
| ![Media: every picture and video in one grid, with the composer at hand](docs/screenshots/media.jpg) | ![A generated photo open in the viewer, with the Segments panel listing the objects found in it](docs/screenshots/viewer-segments.jpg) |
| **Media** — everything in one grid: search, filter, start from any of it | **Viewer** — Segments finds the objects in a photo to edit one by one |
| ![Library: every file, filtered by kind and searchable](docs/screenshots/library.jpg) | ![Plugins: installed, available, and language packs](docs/screenshots/plugins.jpg) |
| **Library** — everything you made, by project | **Plugins** — optional features and language packs, installed from the page |

## Supported models

What `config.example.yaml` wires to each action, read from the graphs in
`workflows/`. The file names are the ones the graphs load: put the weights in
the matching ComfyUI folders, or edit the graph to use your own. Any action can
point at another graph — see [The workflows](#the-workflows).

| Action | Model family | Weights the graph loads |
|---|---|---|
| Generate image, redraw a video's first frame | **Krea 2 Turbo** ([Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2)) | `krea2_turbo_int8_convrot` (or `krea2_turbo_nvfp4` on an RTX 50), text encoder `qwen3vl_4b_int8_convrot`, VAE `qwen_image_vae` |
| Edit photo, precise edit (brush), reference image | **Krea 2 Turbo** + identity-edit LoRA | the three above + `krea2_identity_edit_v1_2` (LoRA) |
| Compose a person with a reference (costume, setting) | **Qwen-Image 2.1** | `qwen_image_2.1_int8_convrot`, `qwen3vl_8b_int8_convrot`, `qwen_image_2.1_vae_bf16` |
| Relight a photo | **FLUX.3 Klein** | `flux3-image-klein-int8-convrot` ([black-forest-labs](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy), gated), `qwen3vl_4b_int8_convrot` (the Krea 2 text encoder), `flux2-vae` |
| Make video, loop, extend, video on a song, recreate video (chained scenes past 6 s) | **MiniMax H3** + **Pika H3 Flex** LoRAs ([Pika-Labs/Pika-H3-Flex](https://huggingface.co/Pika-Labs/Pika-H3-Flex): adapters on top of MiniMax H3, not a separate model) | `minimax_h3_fl2va` / `minimax_h3_ref2va` (int8), text encoder `qwen3vl_32b_minimax_h3_nvfp4_awq`, video and audio VAEs; fast recipe: `pika_h3_flex_turbo_4step_{fl2va,ref2va}` ([Pika-H3-Flex-Turbo-LoRA](https://huggingface.co/Pika-Labs/Pika-H3-Flex-Turbo-LoRA)), 4 steps; quality recipe: `pika_h3_flex_{fl2va,ref2va}_v1_bf16` (ComfyUI build in [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3)), 6 steps |
| Edit object in a video: change, remove, background, add; character swap (lip-sync on or off) | **MiniMax H3** + **SAM 3.1** + Qwen3-VL 8B (describer) | `minimax_h3_ref2va` + the DMAD 4-step LoRA ([Kijai/MiniMax-H3-experimental](https://huggingface.co/Kijai/MiniMax-H3-experimental)) at 6 steps, `sam3.1_multiplex_fp16` — the masked-edit recipe Openjutsu uses |
| Regenerate detail (video at 1.5×) | **MiniMax H3** | latent upscaler 3D + `minimax_h3_open_regenerate_2k` LoRA |
| Segments (objects in a photo) | **SAM 3.1** + the vision model | `sam3.1_multiplex_fp16`, node in [comfyui-nodes/comfyui-imagine](comfyui-nodes/comfyui-imagine) |
| Upscale photo / video | **SeedVR2** | `seedvr2_7b_sharp_int8_convrot` (photo), `seedvr2_3b_int8_convrot` (video), `ema_vae_fp16` — ComfyUI's native SeedVR2 nodes, NVFP4 builds on an RTX 50 ([Comfy-Org/SeedVR2](https://huggingface.co/Comfy-Org/SeedVR2)) |
| Remove background | **BiRefNet** | `birefnet` |
| Music | **MiniMax Music 3** | `minimax_music3_dit_fp16`, its text encoder and `minimax_music3_dav` |
| Change voice / extract vocals | **RVC** / **MelBand RoFormer** | your `voice-model.pth`; `MelBandRoformer_fp16` |
| Remove object (photo) | **LaMa** in IOPaint | through the IOPaint plugin, outside ComfyUI |

**Installed for you:** every action that runs in ComfyUI except the two voice
ones. With the
[comfyui-imagine](#the-comfyui-pack) pack in ComfyUI, the first request that
needs them downloads the weights above from Hugging Face and the node packs
they use:

- Krea 2, Segments, Remove background: about 22.6 GB. On an RTX 50 (Blackwell)
  it takes the NVFP4 build of Krea 2 instead: 7.7 GB rather than 13.5, and on
  an RTX 5070 Ti about 11% faster with 3.5 GB less VRAM at the same quality.
- MiniMax H3 video: about 76 GB with the NVFP4 text encoder on an RTX 50, or
  about 88 GB with the INT8 one on other cards; each action downloads only the
  files it uses.
- Music: about 14.3 GB.
- Compose (Qwen-Image 2.1): about 17.3 GB.
- Relight (FLUX.3 Klein): about 5.6 GB on an RTX 50 (NVFP4), 6.2 GB on other
  cards, on top of the Krea 2 text encoder. Its
  weights are in a **gated** repo: accept the licence on
  [its page](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy)
  with your Hugging Face account and put a token of that account in
  Settings → ComfyUI setup; without one, the chat says so before anything is
  downloaded.
- Upscale: photo 4.8 GB on an RTX 50 (8.3 GB on other cards), video 2.0 GB
  (3.5 GB), plus a 0.5 GB VAE; long videos also use Video Helper Suite.

Most of the H3 node packs are marked **Flagged** in the Comfy Registry, and a
few come straight from GitHub because the registry does not carry them. Imagine
installs them only at the exact version it was tested with, checked file by
file, and always asks first, even with **Install automatically** on: the chat
card says where each pack comes from. A version the registry has banned is
never installed.

Change voice and Extract vocals still go in by hand: they need
[TTS Audio Suite](https://github.com/diodiogod/TTS-Audio-Suite), a large pack
with many dependencies, and Change voice runs your own RVC voice model.

**Text and vision** go to any OpenAI-compatible chat-completions endpoint
(Ollama, vLLM, LM Studio, llama.cpp, a hosted API): the model writes the
prompts, reads photos and frames, and names projects. One with image input is
recommended — Segments, Recreate and the photo descriptions need it.

## Requirements

- Node 24 or newer (`package.json` declares `"engines": { "node": ">=24" }`).
- `git`, to get the code and to update it.
- `ffmpeg` and `ffprobe` on the `PATH`: thumbnails, crops, trims and every
  video step use them (`apt install ffmpeg` on Debian/Ubuntu).
- A reachable ComfyUI (0.45 or newer) with the **comfyui-imagine** pack — see
  [The ComfyUI pack](#the-comfyui-pack). It installs the models and nodes of the
  Krea 2 actions by itself; for the other actions, the custom nodes and weights
  their graphs name go in by hand. **Weights are not included in this repository.**
- An OpenAI-compatible endpoint for text, and ideally one that takes images.

## Install

```sh
git clone https://github.com/BTekV4/comfyui-imagine.git
cd comfyui-imagine
npm install
cp config.example.yaml config.yaml     # then edit it: ComfyUI's address, your model endpoint
npm run build
node dist/server.mjs
```

To keep it running, `deploy/imagine.service` is a systemd unit to copy (it
assumes the app in `/opt/imagine`; keys go in `/opt/imagine/imagine.env`).

To update: `git pull`, `npm install`, `npm run build`, restart. The plugins you
installed are brought up to the new version at the next start (the old files
stay beside them as `*.bak-<time>-update`; their settings are never touched).

`npm run build` runs `scripts/build.mjs`, which bundles the server
(`dist/server.mjs`), the MCP server (`dist/imagine-mcp.mjs`) and the TypeScript
plugins (`plugins/<id>/index.mjs`) with esbuild, then `vite build web` builds
the page into `dist/web`. Each part also builds alone: `npm run build:server`,
`build:mcp`, `build:plugins`, `build:web`. `npm test` runs the test suite.

Open `http://localhost:3090`.

### The ComfyUI pack

`comfyui-nodes/comfyui-imagine` is the one thing to copy into ComfyUI by hand:

```sh
cp -r comfyui-nodes/comfyui-imagine /path/to/ComfyUI/custom_nodes/
# restart ComfyUI
```

It brings the nodes the studio's graphs use (Segments, the precise-edit crop and
stitch, lossless WebP/PNG saving) and the **setup** the studio asks before every
run. When a request needs a node pack or a model ComfyUI does not have, the chat
says what and how much, and asks **Install**; then it shows the download, restarts
ComfyUI if a node pack came in, and the same request goes on. Only what the
pack's `manifest.json` lists can be installed, each file checked by SHA-256.

In **Settings → ComfyUI setup**: **Install automatically** skips the question,
and a **Hugging Face token** is used for models that need an account (none of the
current ones do). Details in [the pack's README](comfyui-nodes/comfyui-imagine/README.md).

**There is no login until you turn it on.** Whoever reaches the address gets
in, so on a shared network set a password in **Settings → Access** and switch on
**Ask for the password**. It works over plain `http://` too; behind an HTTPS
reverse proxy the login cookie is also marked `Secure` (the proxy must send
`X-Forwarded-Proto`, as nginx and Nginx Proxy Manager do).

The files live in two places:

| Where | What |
|---|---|
| Paths in `config.yaml`, read relative to that file (`./data/…` in the example) | the media the studio makes (`toolComfy.outputDir`), the password hash (`passwordFile`) and the cookie secret (`secretFile`) |
| `<data>`: `$IMAGINE_HOME`, or `~/.imagine` when the variable is not set | projects, likes and tags, thumbnails, installed plugins and language packs, custom workflows, custom covers, and the settings the page writes |

Back up both. Pointing `toolComfy.outputDir` inside `<data>` keeps everything
in one folder.

## Configuration

Everything deployment-specific lives in `config.yaml` — no address, path or
model name is compiled into the code, and every path in it is read relative to
the file itself.

| Key | What it is |
|---|---|
| `providers` / `models` | One entry per OpenAI-shaped endpoint and the models it serves. `vision: true` marks the ones that can read a frame. |
| `comfy.baseURL` | Where ComfyUI listens. |
| `toolComfy.workflows` | One entry per action: the graph file, the output extension, and the ids of the nodes carrying the prompt, seed, canvas or input image. An entry you leave out disables that action. |
| `toolComfy.persona.path` | Who the prompts describe. See below. |
| `toolComfy.tts` | The speech endpoint for the `speak` action. |

### The persona

Every prompt that has to show a person starts with the same paragraph, and that
paragraph is data: a JSON file named by `toolComfy.persona.path`.

```json
{
  "identity": "The subject, a person standing alone in the photograph, photographed from the front in natural light.",
  "hair": ""
}
```

- `identity` — the paragraph prepended to every draw.
- `hair` — a colour to pin in the text, when the source frame keeps winning.
  Empty leaves the text alone.

A deployment without a persona file boots and works: it draws a neutral,
undescribed person.

## The workflows

`workflows/` holds the graphs in ComfyUI's API format — the same JSON you get
from "Save (API format)". `config.example.yaml` wires them to the actions,
with the node ids that match the shipped files (each Pika clip graph carries a
fast and a quality recipe: the entry's `highInputs` lists the inputs the
quality one writes over the graph; a second graph as `pathHigh` also works).
[workflows/README.md](workflows/README.md) lists every file, the
config key it serves and what it does. They are examples from one machine: the
model and LoRA names in them are the ones installed there, so adapt them to
your ComfyUI. Change a graph, change the model, or write your own, then update
the pins.

There is no LoRA switching by keyword anywhere: a graph is static, and what
varies at run time is only what the pins address.

## The home covers

The cards on the home page come with covers made with the studio itself, from
invented subjects (`web/public/imagine/`). To use your own, pick an action in
**Settings → Workflows** and choose a file under "Cover for this action" (an
image or a short video), or put files named after the card's key into
`<data>/covers/` (for example `<data>/covers/video.webp`). Your covers live in
the data directory, win over the shipped ones, and updates do not touch them.

## Languages

| Language | Code | How |
|---|---|---|
| English | `en` | built in, the source of every text |
| Italian | `it` | pack shipped in `locales/it.json`, installed from **Plugins → Languages** |

A new language is one JSON file of the same keys — translate as much as you
like, the rest reads English. Packs for more languages are very welcome as
pull requests.

English is the source language: it is compiled into the page and is the
fallback for any key a pack leaves out. Every other language is a pack — one
JSON file — installed at runtime; see
[docs/language-packs.md](docs/language-packs.md). The `locales/` folder holds the
packs this repository ships (Italian, `locales/it.json`); the Plugins page
installs them.

A browser that has never chosen a language starts in the first of its own
languages that the installation has (English, or an installed pack), else in
English. To change the language,
pick one in **Settings → Language** (the choice is kept in a cookie and in the
browser's storage), or open the page with `?lang=en` (any installed code works).

The server writes its own texts (errors, notices composed in the background)
in the language of the page that asked, and otherwise in the installation's base
language: `language:` in `config.yaml`, `en` by default (`it` is the other one
the server speaks).

## Plugins

Extra features are plugins, installed as a folder under `<data>/plugins/<id>/`
with a `manifest.json` and an `index.mjs`. The studio with no plugins is the
studio as described in this file: no route, no section in the settings page, no
timer. A plugin declares its settings in the manifest and the settings page draws
them, so adding one needs no change here.

The base studio has no social side at all: publishing to Instagram and the
Telegram alerts are plugins too, in `plugins/instagram/` and `plugins/telegram/`,
and `plugins/example-webhook/` is the small one to copy. The page **Plugin** in
the rail lists what is installed (with a switch each), what could not load, and
what the repository ships and the data folder does not have — with an Install
button, so installing one needs no terminal.

`plugins/openjutsu/` and `plugins/iopaint/` show two separate web apps inside the
studio (and IOPaint also powers **Remove object**). The apps are not part of this
repository: install and run them on their own, then enter their address in the
plugin's settings. Their READMEs say what each one needs.

`docs/plugin-api.md` is the contract: manifest fields, the `ctx` a plugin is set
up with, routes under `/plugin/<id>/`, the tick and the status, how settings are
stored and validated, and what happens when a plugin is broken. A plugin can be
plain `.mjs` or TypeScript: `npm run build:plugins` bundles `plugins/<id>/src/`
into the `index.mjs` the host loads, inlining the host modules it imports.

## Status

This is a working studio published as-is, not a framework. The graphs are tied to
specific model families (Krea 2 for images, MiniMax H3 for video; Qwen-Image,
FLUX.3 Klein, SeedVR2 and MiniMax Music for single actions) because
that is what the recipes were measured on. Other families work if you write the graph.

## Contributing

Help is welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to run it in
development, the tests, and the few rules the code follows. Bugs and ideas go to
[GitHub issues](https://github.com/BTekV4/comfyui-imagine/issues).

## Acknowledgements

Imagine was built with a lot of help, and it shows in the code and in the studio:

- **[Claude](https://www.anthropic.com/claude)** (Anthropic) — pair programmer for
  most of the code, the reviews and the tests.
- **[Grok](https://grok.com)** (xAI) — Grok Imagine is the model for the studio's
  look and flow: the canvas, the photo viewer and its tools, Segments.
- **[DeepSeek](https://www.deepseek.com)** — the studio started inside DeepSeek
  Harness (see `NOTICE`), and DeepSeek models drive its chat.
- **[Qwen](https://qwen.ai)** (Alibaba) — Qwen-Image and the Qwen3-VL text and
  vision encoders behind Krea 2, MiniMax H3 and FLUX.3 Klein in these graphs.

- **Openjutsu**, **[D3voz's one-click swap nodes](https://github.com/D3voz/comfyui-h3-oneclick-swap)**
  and **[ethanfel's MiniMax H3 Context Loop](https://github.com/ethanfel/ComfyUI-MiniMaxH3-Context-Loop)**
  — the character and object swaps follow Openjutsu's graphs, and every long
  video is chained the way their plans do it.

And to everyone behind ComfyUI and the open models the graphs run on.

## License

MIT — see `LICENSE`. Portions derive from DeepSeek Harness (MIT); the notice is
in `NOTICE`. The model weights the graphs reference are not distributed here and
carry their own licenses.
