"""Save images as WebP (lossless by default) or PNG, in a dated output subfolder.

Core ComfyUI saves PNG (SaveImage) or PNG/EXR/AVIF (SaveImageAdvanced); the
studio's graphs write lossless WebP, about half the size of a PNG at 1080p.
"""

import os
import time

import folder_paths
import numpy as np
from PIL import Image


class ImagineSaveImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "filename_prefix": ("STRING", {"default": "Imagine"}),
                "format": (["webp", "png"],),
                "lossless": ("BOOLEAN", {"default": True, "tooltip": "WebP only."}),
                "quality": ("INT", {"default": 95, "min": 1, "max": 100, "tooltip": "Lossy WebP only."}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "Imagine"

    def save(self, images, filename_prefix, format, lossless, quality):
        subfolder = time.strftime("%Y-%m-%d")
        prefix = os.path.basename(filename_prefix) or "Imagine"
        folder = os.path.join(folder_paths.get_output_directory(), subfolder)
        os.makedirs(folder, exist_ok=True)
        taken = [name for name in os.listdir(folder) if name.startswith(f"{prefix}_")]
        counter = len(taken) + 1
        results = []
        for image in images:
            pixels = Image.fromarray(np.clip(image.cpu().numpy() * 255.0, 0, 255).astype(np.uint8))
            while True:
                name = f"{prefix}_{counter:05}.{format}"
                if not os.path.exists(os.path.join(folder, name)):
                    break
                counter += 1
            if format == "webp":
                pixels.save(os.path.join(folder, name), "WEBP", lossless=lossless, quality=quality, method=4)
            else:
                pixels.save(os.path.join(folder, name), "PNG", compress_level=4)
            results.append({"filename": name, "subfolder": subfolder, "type": "output"})
            counter += 1
        return {"ui": {"images": results}}


NODE_CLASS_MAPPINGS = {"ImagineSaveImage": ImagineSaveImage}
NODE_DISPLAY_NAME_MAPPINGS = {"ImagineSaveImage": "Imagine Save Image"}
