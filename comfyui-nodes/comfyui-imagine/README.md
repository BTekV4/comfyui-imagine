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
| `GET /imagine/setup/status` | version, when this ComfyUI started, which manifest packs and models are installed, the install in progress |
| `POST /imagine/setup/check` | `{"prompt": <API graph>}` → the node packs and model files it is missing, and anything missing that the manifest does not know |
| `POST /imagine/setup/install` | `{"packs": [...], "models": [...]}` → installs them in the background; an `X-HF-Token` header is used for Hugging Face downloads only |
| `POST /imagine/setup/restart` | restarts ComfyUI, to load node packs just installed |

**Only what `manifest.json` lists can be installed.** A request names entries,
never URLs or paths: a node pack is a fixed archive of the Comfy Registry, a model
a fixed file on Hugging Face, each with its size and SHA-256. A download that does
not match is discarded. Downloads resume where they stopped. Nothing is fetched
unless Imagine asks, and Imagine asks only after the user said yes in the chat (or
turned on **Install automatically**).

A node pack's `requirements.txt`, if it has one, is installed with ComfyUI's own
`pip`.

## Adding to the manifest

```json
"packs": {
  "<registry id>": { "name": "...", "version": "...", "url": "https://cdn.comfy.org/<publisher>/<id>/<version>/node.zip",
                     "size": 0, "sha256": "...", "folder": "<folder in custom_nodes>", "classes": ["NodeClass", "..."] }
},
"models": {
  "<name as the graph writes it>": { "folder": "<models folder>", "url": "https://huggingface.co/.../resolve/main/...",
                                     "size": 0, "sha256": "..." }
}
```

`size` and `sha256` of a Hugging Face file are in its repo's file listing (the
LFS object id is the SHA-256). Prefer official repos (Comfy-Org and the model's
authors), and packs with no extra dependencies.
