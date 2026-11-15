# Imagine Segments (ComfyUI node)

The node behind the **Segments** panel of the photo viewer: SAM 3 run over a
list of concepts, one mask and one transparent cut-out per object, plus the
boxes of readable text, with a JSON index Imagine reads back.

## Install

Copy this folder into ComfyUI's `custom_nodes` and restart ComfyUI:

```sh
cp -r comfyui-nodes/imagine-segments /path/to/ComfyUI/custom_nodes/comfyui-imagine-segments
```

It needs ComfyUI's native SAM 3 nodes (ComfyUI 0.45 or newer) and the
`sam3.1_multiplex_fp16.safetensors` checkpoint in `models/checkpoints`. Imagine
asks the vision model for the list of concepts, uploads the photo, runs the node
and keeps the results under `<data>/comfy/segments/`.

## Inputs

| Input | What |
|---|---|
| `model`, `clip` | from a `CheckpointLoaderSimple` with the SAM 3.1 checkpoint |
| `image` | the photo |
| `concepts` | one concept per line; `concept:N` keeps at most N objects (default 10) |
| `texts` | JSON list of `{"text", "box": {"x","y","w","h"}}` in fractions of the photo, as the vision model read them; each box is moved onto the nearest text SAM 3 finds |
| `threshold`, `refine_iterations` | detection score, and how many times SAM 3 refines each mask |
| `dedupe_iou`, `min_area`, `max_area` | overlap above which two masks are the same object, smallest and largest area kept |
| `filename_prefix` | the start of the saved file names |
| `save_to` | `output` or `temp` |

The result is `<stem>_mask_<i>.png`, `<stem>_cut_<i>.png` and
`<stem>_index.json`, listed in the node's UI output.
