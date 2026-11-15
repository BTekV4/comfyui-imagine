/**
 * Style presets for "Change style": each restyles a source image through the
 * edit_image tool. The label (a locale key) is the user-facing option; the prompt is the
 * edit instruction sent to the model, written in English (which the image-edit
 * model follows most reliably) and phrased to keep the subject, pose, and
 * composition while changing only the rendering style.
 */

import type { ComfyLocaleKey } from './locales.ts'

/** One selectable restyle: the label's locale key plus the edit instruction. */
export interface StylePreset {
  readonly id: string
  readonly labelKey: ComfyLocaleKey
  readonly prompt: string
}

/** Keep the subject; change only the style. Appended to every preset prompt. */
const KEEP = 'Keep the same subject, faces, pose, and composition; change only the artistic style.'

/** The shipped restyle presets, in menu order. */
export const STYLE_PRESETS: readonly StylePreset[] = Object.freeze([
  { id: 'ghibli', labelKey: 'imagine.stylePreset.ghibli',
    prompt: `Redraw this image as a Studio Ghibli anime frame: soft hand-painted backgrounds, gentle cel shading, warm natural light, delicate line work. ${KEEP}` },
  { id: 'dragonball', labelKey: 'imagine.stylePreset.dragonball',
    prompt: `Redraw this image in the Dragon Ball / Akira Toriyama anime style: bold clean outlines, cel shading, saturated colors, spiky dynamic shapes. ${KEEP}` },
  { id: 'naruto', labelKey: 'imagine.stylePreset.naruto',
    prompt: `Redraw this image in the Naruto / Masashi Kishimoto shonen anime style: sharp inked outlines, flat cel shading, expressive faces. ${KEEP}` },
  { id: 'onepiece', labelKey: 'imagine.stylePreset.onepiece',
    prompt: `Redraw this image in the One Piece / Eiichiro Oda anime style: exaggerated proportions, bold outlines, bright flat colors, playful cartoon energy. ${KEEP}` },
  { id: 'pixar', labelKey: 'imagine.stylePreset.pixar',
    prompt: `Re-render this image as a Pixar-style 3D animated film still: smooth stylized 3D characters, soft global illumination, rounded shapes, cinematic depth of field. ${KEEP}` },
  { id: 'comic', labelKey: 'imagine.stylePreset.comic',
    prompt: `Redraw this image as a Western comic-book panel: heavy black inking, halftone dot shading, bold primary colors, dramatic contrast. ${KEEP}` },
  { id: 'manga', labelKey: 'imagine.stylePreset.manga',
    prompt: `Redraw this image as a black-and-white manga page: inked line art, screentone shading, no color, high contrast. ${KEEP}` },
  { id: 'watercolor', labelKey: 'imagine.stylePreset.watercolor',
    prompt: `Repaint this image as a loose watercolor: visible paper texture, soft bleeding washes, gentle pigments, hand-painted edges. ${KEEP}` },
  { id: 'oil', labelKey: 'imagine.stylePreset.oil',
    prompt: `Repaint this image as a classical oil painting: visible brush strokes, rich impasto texture, warm gallery lighting. ${KEEP}` },
  { id: 'nineties', labelKey: 'imagine.stylePreset.nineties',
    prompt: `Restyle this image as a 1990s photograph: warm faded film colors, soft grain, slight light leaks, nostalgic analog look. ${KEEP}` },
  { id: 'bw', labelKey: 'imagine.stylePreset.bw',
    prompt: `Convert this image to a high-contrast black-and-white photograph: rich tonal range, deep blacks, no color at all. ${KEEP}` },
  { id: 'cyberpunk', labelKey: 'imagine.stylePreset.cyberpunk',
    prompt: `Restyle this image as a neon cyberpunk scene: teal and magenta neon lighting, rain-slick reflections, futuristic mood, cinematic glow. ${KEEP}` },
  { id: 'vaporwave', labelKey: 'imagine.stylePreset.vaporwave',
    prompt: `Restyle this image as vaporwave art: pastel pink and cyan palette, retro 80s gradients, dreamy glow, VHS aesthetic. ${KEEP}` },
  { id: 'pixel', labelKey: 'imagine.stylePreset.pixel',
    prompt: `Redraw this image as 16-bit pixel art: chunky pixels, limited retro palette, dithering, crisp sprite edges. ${KEEP}` },
])
