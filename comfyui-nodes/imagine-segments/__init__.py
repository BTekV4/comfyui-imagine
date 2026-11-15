"""Imagine Segments: SAM 3 run over a list of concepts, one object per mask.

Built for the Segments panel of Imagine (web/vendor-imagine/client/SegmentsPanel.tsx). Given a photo and a list of
concepts (one per line, optional ":N" = at most N objects, default 10), it runs
the native SAM3 detector once per concept, drops masks that repeat an object
already found (IoU), and saves for every segment:

  <stem>_mask_<i>.png    full-size mask, white = segment
  <stem>_cut_<i>.png     RGBA cut-out, cropped to the segment's box
  <stem>_index.json      the list below

Readable texts come from the caller (a vision model reads the words, SAM 3
does not): a JSON list [{"text", "box": {"x","y","w","h"}}] in fractions of the
photo. The box a vision model gives is often off, so it is moved onto the
nearest "text" SAM 3 finds; the segment is that rectangle.

Index: {"width", "height", "segments": [{"index", "kind": "object"|"text",
"label", "score", "bbox": {"x","y","w","h"}, "area", "mask", "cut"}]}, pixels.
A concept that finds nothing is simply absent: the node never fails on it.
"""

import json
import os
import re

import numpy as np
import torch
from PIL import Image

import folder_paths
from comfy_extras.nodes_sam3 import SAM3_Detect

DEFAULT_MAX = 10
MAX_TEXT_BOXES = 30
LINE = re.compile(r"^(.+?)\s*:\s*(\d+)\s*$")


def parse_concepts(text):
    """Lines (or commas) → [(label, max_objects)], duplicates removed, order kept."""
    seen = set()
    out = []
    for raw in re.split(r"[\n,]", text or ""):
        part = raw.strip()
        if not part:
            continue
        m = LINE.match(part)
        label, n = (m.group(1).strip(), int(m.group(2))) if m else (part, DEFAULT_MAX)
        label = label.replace("(", "").replace(")", "").replace(":", " ").strip()
        key = label.lower()
        if not label or key in seen:
            continue
        seen.add(key)
        out.append((label, max(1, min(n, 64))))
    return out


def parse_texts(text, W, H):
    """The caller's texts as [(words, (x0, y0, x1, y1) in pixels)]; anything malformed is skipped."""
    if not (text or "").strip():
        return []
    out = []
    for entry in json.loads(text):
        words = str(entry.get("text", "")).strip()
        box = entry.get("box") or {}
        x, y, w, h = (float(box.get(k, 0)) for k in ("x", "y", "w", "h"))
        if not words or w <= 0 or h <= 0:
            continue
        x0, y0 = max(0, int(x * W)), max(0, int(y * H))
        x1, y1 = min(W, int(round((x + w) * W))), min(H, int(round((y + h) * H)))
        if x1 > x0 and y1 > y0:
            out.append((words, (x0, y0, x1, y1)))
    return out


def iou(a, b):
    inter = torch.logical_and(a, b).sum().item()
    if inter == 0:
        return 0.0
    return inter / torch.logical_or(a, b).sum().item()


def box_iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if inter == 0:
        return 0.0
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def place_texts(texts, found, W, H):
    """Move each caller box onto the SAM 3 text box that overlaps it most, else the
    nearest one within 20% of the photo; each found box is used once."""
    reach = 0.2 * max(W, H)
    free = list(found)
    out = []
    for words, box in texts:
        best = None
        if free:
            by_iou = max(free, key=lambda f: box_iou(box, f[0]))
            if box_iou(box, by_iou[0]) > 0:
                best = by_iou
            else:
                cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
                near = min(free, key=lambda f: ((f[0][0] + f[0][2]) / 2 - cx) ** 2 + ((f[0][1] + f[0][3]) / 2 - cy) ** 2)
                if ((near[0][0] + near[0][2]) / 2 - cx) ** 2 + ((near[0][1] + near[0][3]) / 2 - cy) ** 2 <= reach ** 2:
                    best = near
        if best is None:
            out.append((words, box, 0.0))
        else:
            free.remove(best)
            out.append((words, best[0], best[1]))
    return out


class ImagineSegments:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "SAM 3 / 3.1 from CheckpointLoaderSimple"}),
                "clip": ("CLIP", {"tooltip": "The CLIP of the same SAM 3 checkpoint"}),
                "image": ("IMAGE",),
                "concepts": ("STRING", {"multiline": True, "default": "person\ncoffee cup:4",
                                        "tooltip": "One concept per line (English noun phrase); ':N' = at most N objects"}),
                "threshold": ("FLOAT", {"default": 0.5, "min": 0.05, "max": 0.95, "step": 0.01}),
                "refine_iterations": ("INT", {"default": 2, "min": 0, "max": 5}),
                "dedupe_iou": ("FLOAT", {"default": 0.85, "min": 0.0, "max": 1.0, "step": 0.01,
                                         "tooltip": "A mask overlapping an earlier one by more than this is the same object (1 = keep all)"}),
                "min_area": ("FLOAT", {"default": 0.0002, "min": 0.0, "max": 0.1, "step": 0.0001,
                                       "tooltip": "Masks smaller than this fraction of the photo are dropped"}),
                "max_area": ("FLOAT", {"default": 0.9, "min": 0.1, "max": 1.0, "step": 0.01,
                                       "tooltip": "Masks larger than this fraction of the photo are dropped (a concept that took the whole frame)"}),
                "filename_prefix": ("STRING", {"default": "imagine-segments/seg"}),
                "save_to": (["output", "temp"], {"default": "output", "tooltip": "temp: ComfyUI's temp folder, emptied at restart (for callers that download the files)"}),
            },
            "optional": {
                "texts": ("STRING", {"multiline": True, "default": "",
                                     "tooltip": "JSON [{\"text\": \"OPEN\", \"box\": {\"x\",\"y\",\"w\",\"h\"}}] in fractions of the photo"}),
            },
        }

    RETURN_TYPES = ("MASK", "STRING")
    RETURN_NAMES = ("masks", "segments")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/detection"
    DESCRIPTION = "SAM 3 over a list of concepts: one mask and one cut-out per object, readable texts as boxes, with a JSON index (Imagine Segments)."

    def detect(self, model, clip, image, label, max_det, threshold, refine_iterations):
        tokens = clip.tokenize(f"{label}:{max_det}" if max_det > 1 else label)
        out = SAM3_Detect.execute(model=model, image=image, conditioning=clip.encode_from_tokens_scheduled(tokens),
                                  threshold=threshold, refine_iterations=refine_iterations, individual_masks=True)
        return list(zip(out.args[0], out.args[1][0]))

    def run(self, model, clip, image, concepts, threshold, refine_iterations, dedupe_iou, min_area, max_area, filename_prefix, save_to, texts=""):
        image = image[:1]
        _, H, W, _ = image.shape
        total = float(H * W)

        found = []  # (kind, label, score, bool mask HxW)
        for label, max_det in parse_concepts(concepts):
            for m, box in self.detect(model, clip, image, label, max_det, threshold, refine_iterations):
                mb = (m > 0.5).cpu()
                share = mb.sum().item() / total
                if min_area <= share <= max_area:
                    found.append(("object", label, float(box["score"]), mb))

        # The same object can answer two concepts ("woman" and "person"): keep the first.
        kept = []
        for item in found:
            if dedupe_iou < 1.0 and any(iou(item[3], k[3]) > dedupe_iou for k in kept):
                continue
            kept.append(item)

        wanted = parse_texts(texts, W, H)
        if wanted:
            sam_boxes = []
            for _, box in self.detect(model, clip, image, "text", MAX_TEXT_BOXES, 0.3, 0):
                sam_boxes.append(((int(box["x"]), int(box["y"]), int(round(box["x"] + box["width"])), int(round(box["y"] + box["height"]))), float(box["score"])))
            for words, (x0, y0, x1, y1), score in place_texts(wanted, sam_boxes, W, H):
                x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
                if x1 <= x0 or y1 <= y0:
                    continue
                mb = torch.zeros(H, W, dtype=torch.bool)
                mb[y0:y1, x0:x1] = True
                kept.append(("text", words, score, mb))

        out_dir = folder_paths.get_temp_directory() if save_to == "temp" else folder_paths.get_output_directory()
        full_out, base, counter, sub, _ = folder_paths.get_save_image_path(filename_prefix, out_dir, W, H)
        stem = f"{base}_{counter:05}"
        rgb = (image[0, ..., :3].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
        segments = []
        files = []
        for i, (kind, label, score, mb) in enumerate(kept):
            alpha = mb.numpy().astype(np.uint8) * 255
            ys, xs = np.nonzero(alpha)
            x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
            mask_name = f"{stem}_mask_{i:03}.png"
            cut_name = f"{stem}_cut_{i:03}.png"
            Image.fromarray(alpha, "L").save(os.path.join(full_out, mask_name), compress_level=4)
            Image.fromarray(np.dstack([rgb[y0:y1, x0:x1], alpha[y0:y1, x0:x1]]), "RGBA").save(os.path.join(full_out, cut_name), compress_level=4)
            segments.append({
                "index": i, "kind": kind, "label": label, "score": round(score, 4),
                "bbox": {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0},
                "area": round(len(xs) / total, 6),
                "mask": mask_name, "cut": cut_name,
            })
            files += [mask_name, cut_name]

        doc = json.dumps({"width": int(W), "height": int(H), "segments": segments}, ensure_ascii=False)
        index_name = f"{stem}_index.json"
        with open(os.path.join(full_out, index_name), "w", encoding="utf-8") as f:
            f.write(doc)
        ui_images = [{"filename": name, "subfolder": sub, "type": save_to} for name in [index_name] + files]
        stack = torch.stack([k[3].float() for k in kept]) if kept else torch.zeros(0, H, W)
        return {"ui": {"images": ui_images}, "result": (stack, doc)}


NODE_CLASS_MAPPINGS = {"ImagineSegments": ImagineSegments}
NODE_DISPLAY_NAME_MAPPINGS = {"ImagineSegments": "Imagine Segments (SAM 3)"}
