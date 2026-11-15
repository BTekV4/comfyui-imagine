"""Crop the zone to edit with some context around it, and stitch the result back.

Precise edit (Imagine's region graph) redraws only a crop of the photo: the
mask's bounding box grown by a context factor, resized so its long side is
`target_size`, and pasted back over the original afterwards. This is the same
procedure ComfyUI_Fill-Nodes' FL_InpaintCrop / FL_Inpaint_Stitch run with the
settings the graph used (max_dimension, holes filled, no square), kept here so
the studio does not need that whole pack for two nodes.
"""

import comfy.utils
import numpy as np
import torch
from PIL import Image, ImageFilter
from scipy.ndimage import binary_closing, binary_fill_holes, grey_dilation


def _to_divisible(low, high, limit, divisible_by):
    """Widen [low, high] around its centre to a multiple of divisible_by, inside [0, limit)."""
    size = high - low + 1
    if divisible_by <= 1 or size % divisible_by == 0:
        return low, high
    size = (size // divisible_by + 1) * divisible_by
    low = int((low + high) / 2 - size / 2)
    high = low + size - 1
    if low < 0:
        low, high = 0, size - 1
    if high >= limit:
        high = limit - 1
        low = max(0, high - size + 1)
    return low, high


class ImagineInpaintCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "context_factor": ("FLOAT", {"default": 2.5, "min": 1.0, "max": 4.0, "step": 0.05, "tooltip": "How much bigger than the mask's box the crop is."}),
                "target_size": ("INT", {"default": 1536, "min": 0, "max": 4096, "step": 16, "tooltip": "Long side of the crop after resizing; 0 keeps its size."}),
                "divisible_by": ("INT", {"default": 16, "min": 1, "max": 64}),
                "fill_mask_holes": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("IMAGINE_STITCH", "IMAGE", "MASK")
    RETURN_NAMES = ("stitch", "cropped_image", "cropped_mask")
    FUNCTION = "crop"
    CATEGORY = "Imagine"

    def crop(self, image, mask, context_factor, target_size, divisible_by, fill_mask_holes):
        height, width = image.shape[1], image.shape[2]
        if mask.dim() == 2:
            mask = mask.unsqueeze(0)
        if mask.shape[-2:] != (height, width):
            mask = torch.nn.functional.interpolate(mask.reshape(-1, 1, *mask.shape[-2:]).float(), size=(height, width), mode="nearest").squeeze(1)
        mask = mask.float().clamp(0.0, 1.0)
        if fill_mask_holes:
            filled = [binary_fill_holes(binary_closing(m.cpu().numpy() > 0, structure=np.ones((5, 5)), border_value=1)) for m in mask]
            mask = torch.from_numpy(np.stack(filled).astype(np.float32))

        ys, xs = torch.nonzero(mask[0], as_tuple=True)
        if ys.numel() == 0:
            return ({"x": 0, "y": 0, "original": image, "scale_x": 1.0, "scale_y": 1.0}, image, mask)

        y0, y1, x0, x1 = ys.min().item(), ys.max().item(), xs.min().item(), xs.max().item()
        grow_y = int((y1 - y0 + 1) * (context_factor - 1.0) / 2)
        grow_x = int((x1 - x0 + 1) * (context_factor - 1.0) / 2)
        y0, y1 = max(y0 - grow_y, 0), min(y1 + grow_y, height - 1)
        x0, x1 = max(x0 - grow_x, 0), min(x1 + grow_x, width - 1)
        x0, x1 = _to_divisible(x0, x1, width, divisible_by)
        y0, y1 = _to_divisible(y0, y1, height, divisible_by)

        cropped_image = image[:, y0:y1 + 1, x0:x1 + 1]
        cropped_mask = mask[:, y0:y1 + 1, x0:x1 + 1]
        crop_w, crop_h = x1 - x0 + 1, y1 - y0 + 1
        scale_x = scale_y = 1.0
        if target_size > 0:
            if crop_w >= crop_h:
                out_w, out_h = target_size, int(crop_h * target_size / crop_w)
            else:
                out_w, out_h = int(crop_w * target_size / crop_h), target_size
            out_w = -(-out_w // divisible_by) * divisible_by
            out_h = -(-out_h // divisible_by) * divisible_by
            cropped_image = comfy.utils.bislerp(cropped_image.movedim(-1, 1), out_w, out_h).movedim(1, -1)
            cropped_mask = comfy.utils.bislerp(cropped_mask.unsqueeze(1), out_w, out_h).squeeze(1)
            scale_x, scale_y = out_w / crop_w, out_h / crop_h

        stitch = {"x": x0, "y": y0, "original": image, "scale_x": scale_x, "scale_y": scale_y}
        return (stitch, cropped_image, cropped_mask)


class ImagineInpaintStitch:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"stitch": ("IMAGINE_STITCH",), "inpainted_image": ("IMAGE",)}}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "stitch"
    CATEGORY = "Imagine"

    def stitch(self, stitch, inpainted_image):
        original = comfy.utils.repeat_to_batch_size(stitch["original"], inpainted_image.shape[0])
        piece = inpainted_image
        if abs(stitch["scale_x"] - 1.0) > 0.001 or abs(stitch["scale_y"] - 1.0) > 0.001:
            width = round(piece.shape[2] / stitch["scale_x"])
            height = round(piece.shape[1] / stitch["scale_y"])
            piece = comfy.utils.bislerp(piece.movedim(-1, 1), width, height).movedim(1, -1)
        out = original.clone()
        x, y = stitch["x"], stitch["y"]
        h = min(piece.shape[1], out.shape[1] - y)
        w = min(piece.shape[2], out.shape[2] - x)
        out[:, y:y + h, x:x + w] = piece[:, :h, :w].to(out.device, out.dtype)
        return (out,)


class ImagineGrowMask:
    """Grow a mask by `expand` pixels, then soften its edge with a Gaussian blur.

    The same result as KJNodes' GrowMaskWithBlur with the settings the region
    graph uses: one 3x3 dilation per pixel (cross-shaped with tapered corners),
    then PIL's GaussianBlur with `blur_radius` as its standard deviation.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": ("MASK",),
                "expand": ("INT", {"default": 16, "min": 0, "max": 512}),
                "tapered_corners": ("BOOLEAN", {"default": True}),
                "blur_radius": ("FLOAT", {"default": 16.0, "min": 0.0, "max": 100.0, "step": 0.1}),
            }
        }

    RETURN_TYPES = ("MASK",)
    FUNCTION = "grow"
    CATEGORY = "Imagine"

    def grow(self, mask, expand, tapered_corners, blur_radius):
        kernel = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool) if tapered_corners else np.ones((3, 3), dtype=bool)
        out = []
        for m in mask.reshape((-1, mask.shape[-2], mask.shape[-1])).cpu().numpy():
            for _ in range(expand):
                m = grey_dilation(m, footprint=kernel)
            if blur_radius > 0:
                pixels = Image.fromarray(np.clip(m * 255.0, 0, 255).astype(np.uint8), mode="L").filter(ImageFilter.GaussianBlur(blur_radius))
                m = np.asarray(pixels, dtype=np.float32) / 255.0
            out.append(torch.from_numpy(np.ascontiguousarray(m, dtype=np.float32)))
        return (torch.stack(out),)


NODE_CLASS_MAPPINGS = {"ImagineInpaintCrop": ImagineInpaintCrop, "ImagineInpaintStitch": ImagineInpaintStitch, "ImagineGrowMask": ImagineGrowMask}
NODE_DISPLAY_NAME_MAPPINGS = {"ImagineInpaintCrop": "Imagine Inpaint Crop", "ImagineInpaintStitch": "Imagine Inpaint Stitch", "ImagineGrowMask": "Imagine Grow Mask"}
