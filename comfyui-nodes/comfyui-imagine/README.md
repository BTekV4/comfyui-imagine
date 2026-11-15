# comfyui-imagine

The ComfyUI side of [ComfyUI Imagine](../../README.md): a few nodes its graphs
use, and the **setup** that installs what a graph needs when the studio asks.

## Install

Copy this folder into ComfyUI's `custom_nodes` and restart ComfyUI:

```sh
cp -r comfyui-nodes/comfyui-imagine /path/to/ComfyUI/custom_nodes/
```

It needs ComfyUI 0.45 or newer and nothing else: no extra Python packages.

## Nodes

| Node | What |
|---|---|
| Imagine Segments (SAM 3) | SAM 3 over a list of concepts: one mask and one transparent cut-out per object, plus the boxes of readable text, with a JSON index. Behind the **Segments** panel. |
| Imagine Inpaint Crop / Stitch | The crop around a zone to edit (its box grown by a context factor, resized to a target size) and the paste back over the photo. **Precise edit** redraws only that crop. |
| Imagine Grow Mask | Grows a mask by some pixels and softens its edge with a Gaussian blur. |
| Imagine Save Image | Saves PNG, or lossless WebP, in a dated subfolder of the output folder. |

## Setup

Imagine calls these routes before running a graph:

| Route | What |
|---|---|
| `GET /imagine/setup/status` | version, when this ComfyUI started, the GPU and its compute capability, which manifest packs and models are installed, the install in progress |
| `POST /imagine/setup/check` | `{"prompt": <API graph>}` → the node packs and model files it is missing, anything missing that the manifest does not know, and `substitutions`: file names Imagine writes in the graph instead (a variant chosen for this GPU) |
| `POST /imagine/setup/install` | `{"packs": [...], "models": [...]}` → installs them in the background; an `X-HF-Token` header is used for Hugging Face downloads only |
| `POST /imagine/setup/restart` | restarts ComfyUI, to load node packs just installed |

**Only what `manifest.json` lists can be installed.** A request names entries,
never URLs or paths: a node pack is a fixed archive of the Comfy Registry, or a
fixed commit on GitHub for the few packs the registry does not carry; a model is
a fixed file on Hugging Face. Each has its size and SHA-256 (for a GitHub pack,
a hash of every file it holds, since GitHub builds its archives on demand). A
download that does not match is discarded. Downloads resume where they stopped. Nothing is fetched
unless Imagine asks, and Imagine asks only after the user said yes in the chat (or
turned on **Install automatically**).

`check` also tells, for each missing pack, where it comes from (`source`:
`registry` or `github`) and what the Comfy Registry says of the pinned version
(`registryStatus`: `Active`, `Flagged`…). Imagine always asks before installing
a pack that is not `Active` in the registry, and the install refuses a version
the registry has `Banned`.

A node pack's `requirements.txt`, if it has one, is installed with ComfyUI's own
`pip`.

## Adding to the manifest

```json
"packs": {
  "<registry id>": { "name": "...", "version": "...", "source": "registry", "registry": { "id": "<registry id>", "version": "..." },
                     "url": "https://cdn.comfy.org/<publisher>/<id>/<version>/node.zip",
                     "size": 0, "sha256": "...", "folder": "<folder in custom_nodes>", "classes": ["NodeClass", "..."] },
  "<a pack only on GitHub>": { "name": "...", "version": "<commit>", "source": "github",
                     "url": "https://github.com/<owner>/<repo>/archive/<full commit>.zip",
                     "treeSha256": "...", "folder": "...", "classes": ["..."] }
},
"models": {
  "<name as the graph writes it>": { "folder": "<models folder>", "url": "https://huggingface.co/.../resolve/main/...",
                                     "size": 0, "sha256": "..." }
}
```

A model can list **variants** for some GPUs. The first request on a GPU whose
compute capability reaches `minComputeCapability` downloads the variant instead
(NVFP4 needs Blackwell: 10.0 and up), and Imagine writes its name in the graph.
A ComfyUI that already has the model, or a variant, keeps using it:

```json
"krea2_turbo_int8_convrot.safetensors": { "folder": "diffusion_models", "url": "...", "size": 0, "sha256": "...",
  "variants": [ { "name": "krea2_turbo_nvfp4.safetensors", "url": "...", "size": 0, "sha256": "...", "minComputeCapability": 10.0 } ] }
```

A model from a **gated** Hugging Face repo (one that asks to accept a licence)
carries `"gated": "<the repo's page>"`: Imagine asks for a token before the
install, and a refused download names that page.

`size` and `sha256` of a Hugging Face file are in its repo's file listing (the
LFS object id is the SHA-256). `treeSha256` is the SHA-256 of the archive's
files listed as `path\0sha256\n`, sorted by path, with the archive's top folder
left out. Prefer official repos (Comfy-Org and the model's authors), registry
packs over GitHub ones, and packs with no extra dependencies.
