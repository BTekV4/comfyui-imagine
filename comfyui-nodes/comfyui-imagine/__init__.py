"""ComfyUI Imagine: the nodes the Imagine studio needs, and its setup routes.

- Imagine Segments: SAM 3 over a list of concepts (segments.py)
- Imagine Inpaint Crop / Stitch: the crop around a zone to edit (inpaint.py)
- Imagine Save Image: lossless WebP output (save.py)
- /imagine/setup/*: install the node packs and models a graph needs (setup.py)
"""

from . import inpaint, save, segments, setup  # noqa: F401  (setup registers its routes)

NODE_CLASS_MAPPINGS = {**segments.NODE_CLASS_MAPPINGS, **inpaint.NODE_CLASS_MAPPINGS, **save.NODE_CLASS_MAPPINGS}
NODE_DISPLAY_NAME_MAPPINGS = {**segments.NODE_DISPLAY_NAME_MAPPINGS, **inpaint.NODE_DISPLAY_NAME_MAPPINGS, **save.NODE_DISPLAY_NAME_MAPPINGS}
