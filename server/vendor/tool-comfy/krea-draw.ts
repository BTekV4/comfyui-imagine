/**
 * Drawing with the Krea 2 graph of «Recreate video»: the canvas a picture is drawn
 * on, the draw itself, and the persona's hair pinned in the text.
 *
 * Used by «Recreate video» for its opening frame and the candidates of its scan.
 * Who the drawn person is comes from the deployment's persona file (see
 * `persona.ts`). Split out of the scan of the character swap, removed on
 * 2026-11-13.
 * @module tool-comfy/krea-draw
 */

import type { ImagineHost } from '../../src/host.ts'
import { activePersona } from './persona.ts'
import { runWorkflow, type LoadedWorkflow } from './index.ts'
import { formatSize, snapToGrid } from './snap-size.ts'
import type { ImagineQuality, ImagineSpeed } from '../../../shared/imagine-types.ts'

/**
 * The short side the opening frame of «Recreate video», which H3 is
 * conditioned on for the whole clip, is drawn at.
 *
 * 1080, not the megapixel the clip renders at: the frame is read again by the
 * encoder at full size, and asking Krea 2 for a 768-pixel portrait and then
 * enlarging it is what made the face soft and "not her" (2026-10-23, measured
 * on the references of the character swap, removed 2026-11-13).
 *
 * The persona's hair is pinned when the persona names a colour: without that
 * line the description of the performer (whichever colour they have) wins over
 * the text that describes the person to draw.
 */
const SCAN_SHORT_SIDE = 1080

/**
 * The canvas an opening frame is drawn on, from the clip's own ratio.
 *
 * The clip's own ratio, because a square or a wider canvas crops the shot's
 * framing, and 1080 on the short side because that is the size the frame is
 * asked for. Sixteen is the stride the Krea 2 latent assumes.
 * @param width - the clip's width in pixels.
 * @param height - the clip's height in pixels.
 * @returns the canvas size, or undefined when the plate cannot be read.
 */
export function scanCanvas(width: number, height: number): { width: number; height: number } | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return undefined
  const scale = SCAN_SHORT_SIDE / Math.min(width, height)
  return { width: snapToGrid(width * scale, 16), height: snapToGrid(height * scale, 16) }
}

/**
 * One Krea 2 picture, filed under its declared name.
 *
 * The one way the studio draws with Krea 2 outside a plain generation: each
 * candidate of a «Recreate video» scan and the opening frame of a recreation.
 * The job's prompt-id callback and cancellation
 * always travel with it: without them a cancelled or expired job left ComfyUI
 * drawing, and the column had no bar.
 * @param ctx - the host context, for the ComfyUI client.
 * @param workflow - the configured Krea 2 graph.
 * @param outputDir - the media output directory.
 * @param draw - the prompt, the canvas (the graph's own when absent), the
 *   declared output path, the job's recipe and its hooks.
 * @returns the absolute path of the picture, or undefined when the graph produced none.
 */
export async function drawKrea(
  ctx: ImagineHost,
  workflow: LoadedWorkflow,
  outputDir: string,
  draw: {
    readonly prompt: string
    readonly canvas?: { readonly width: number; readonly height: number }
    readonly declared: string
    /**
     * The recipe the job asked for: `quality: 'high'` (or `speed: 'slow'`)
     * writes the workflow's `steps.high` into the sampler, the same way every
     * other Krea 2 action does. Without it the draw always ran at the graph's
     * own 8 steps.
     */
    readonly quality?: ImagineQuality | undefined
    readonly speed?: ImagineSpeed | undefined
    readonly onPrompt?: (promptId: string) => void
    readonly signal?: AbortSignal
  },
): Promise<string | undefined> {
  const run = await runWorkflow(ctx, workflow, outputDir, {
    prompt: draw.prompt,
    seed: Math.floor(Math.random() * 0xffffffff),
    ...draw.quality === undefined ? {} : { quality: draw.quality },
    ...draw.speed === undefined ? {} : { speed: draw.speed },
    ...draw.canvas === undefined ? {} : { size: formatSize(draw.canvas) },
  }, {
    declared: draw.declared,
    ...draw.onPrompt === undefined ? {} : { onPrompt: draw.onPrompt },
    ...draw.signal === undefined ? {} : { signal: draw.signal },
  })
  return run.files.find(file => file.kind === 'image')?.path
}

/**
 * The active persona's hair (`activePersona().hair`), pinned in the text
 * Krea 2 draws from.
 *
 * The reading of the frame describes the performer too, and on a dark-haired
 * clip that description beats the identity blurb: measured 2026-10-23 on one
 * clip (a blonde persona), two draws came out one blonde and one brunette
 * depending on the seed. Asking the writer for the colour in the brief was not
 * enough either (same clip, still brunette), so the colour is pinned in the
 * text itself: a dark or grey hair colour the paragraph names is rewritten to
 * the persona's, and a paragraph that never names it gets one sentence.
 * @param scan - the paragraph the vision pass answered.
 * @returns the paragraph with the persona's hair colour, or unchanged when the
 *   persona declares no hair.
 */
export function pinHair(scan: string): string {
  const hair = activePersona().hair
  if (hair === '') return scan
  const recoloured = scan.replace(
    /\b(black|jet[- ]black|dark[- ]brown|dark|brown|auburn|chestnut|raven|grey|gray|silver[- ]?streaked|silver|white)\b((?:\s+[a-z-]+){0,2})\s+hair\b/gi,
    `${hair}$2 hair`,
  )
  // A reply that never mentions the hair gets one phrase, because the colour is
  // the one thing the clip cannot recover from a wrong opening frame.
  return new RegExp(`\\b${hair}\\b`, 'i').test(recoloured)
    ? recoloured
    : `${recoloured} She has long ${hair} hair.`
}
