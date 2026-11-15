/**
 * «Ricrea video»: a clip is read, redrawn and shot again.
 *
 * The three steps are the ones a person did by hand before this existed: pull
 * the reference clip's frames out and read them, draw the opening frame again
 * with Krea 2 so the clip starts from a picture the studio owns, then render a
 * new clip from that picture with a prompt written for it. The scene and the
 * wardrobe are the reference clip's; the person is the deployment's persona,
 * because the frame is drawn by the same Krea 2 graph its scan uses.
 * What the module
 * removes is the hand-carrying: the paragraph the analysis wrote and the
 * picture it produced are both needed by the render, and neither is a file the
 * user should have to move between two pages.
 * @module tool-comfy/recreate-video
 */

import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { eyesOf } from './eyes.ts'
import { declaredOutputPath, type LoadedWorkflow } from './index.ts'
import { labelledValue, withoutLineMarks } from './model-json.ts'
import { lookWith } from './imagine-models.ts'
import type { ImagineQuality, ImagineSpeed, ModelRoute } from '../../../shared/imagine-types.ts'
import { ffmpegTo, frameAt, mapWithConcurrency } from './media-tools.ts'
import { drawKrea, pinHair } from './krea-draw.ts'
import { activePersona } from './persona.ts'
import { message } from '../../src/messages.ts'

/**
 * How many moments of the reference the reading looks at.
 *
 * Six, because the point of reading a clip rather than its first frame is the
 * action: three would show its beginning, its middle and its end and miss the
 * turn in between, and every extra frame costs a tile of resolution on a model
 * that reads a picture, not a film.
 */
const SHEET_FRAMES = 6

/** The sheet's columns: three over two, read left to right and top to bottom. */
const SHEET_COLUMNS = 3

/**
 * The side each tile is scaled to before they are tiled.
 *
 * 512, not the 1024 the vision call is given: a sheet is six pictures and the
 * model receives one, so a bigger tile is bought by the details of the others.
 */
const SHEET_TILE_SIDE = 512

/** How many tiles of the sheet are pulled out of the clip at once. */
const SHEET_CONCURRENCY = 3

/**
 * What the vision model is asked about the reference clip.
 *
 * The `frame` paragraph is a Krea 2 prompt, because it feeds the Krea 2 graph
 * that draws the opening frame: the person described in detail, then the
 * scene, the wardrobe, the light and the framing. Who that
 * person IS is not the model's to say — the identity paragraph is put in front
 * of the reply by code (`readReferenceClip`), where it cannot be paraphrased
 * away from the LoRA's trigger.
 */
const ANALYSIS_RULES = `Reply ONLY with the two fields below, with no other text.

frame: a description in ENGLISH, detailed and in a single block of fluid, dense text, ready as a prompt for an image generation model (Krea 2 / Flux). Describe, in this order: the person (face, eyes, face shape, expression, hair, build and proportions, skin tone, make-up), the pose and the body language (position, orientation relative to the camera, hands, contact with surfaces), the wardrobe and the accessories garment by garment (type, colour, material, fit), the setting with the objects of the background, the light (type, direction, quality, palette), the framing and the photographic style. Describe ONLY what is visible: no person's name, no guess about who they are, no judgement. Prefer concrete details to abstract words.

motion: a description in ENGLISH of what happens in the clip, from the first frame to the last: the subject's actions in the order they happen, the camera movements, the changes of pose and light. Two dense sentences are enough: it is the track the second pass will follow to shoot the scene again. Do not describe what is not visible between the frames; if the scene changes from one tile to the next, say so.`

/**
 * The instruction sent with the contact sheet of the reference clip.
 *
 * The sheet's own geometry is spelled out because the model has to know which
 * tile is the opening frame: read as one wide picture, the whole sheet is a
 * row of moments and the paragraph for Krea 2 describes all of them.
 * @param frames - how many tiles the sheet carries.
 * @param width - the reference clip's width in pixels.
 * @param height - the reference clip's height in pixels.
 * @param seconds - the reference clip's length.
 * @returns the instruction.
 */
function analysisInstruction(frames: number, width: number, height: number, seconds: number): string {
  const rows = Math.ceil(frames / SHEET_COLUMNS)
  return `These images are ${String(frames)} frames of the SAME video, in time order, laid out in a grid of ${String(SHEET_COLUMNS)} columns and ${String(rows)} rows: they are read left to right and top to bottom. The tile at the top left is the first frame of the clip.

The reference clip lasts ${seconds.toFixed(1)} seconds and is ${String(width)}x${String(height)} pixels.

${ANALYSIS_RULES}`
}

/** What the reading of the reference clip produced. */
export interface ReferenceReading {
  /** The paragraph Krea 2 draws the opening frame from. */
  readonly frame: string
  /** What happens over the clip, when the reading said it in a section of its own. */
  readonly motion?: string
}

/**
 * One still per moment of the clip, tiled into the single picture the vision
 * model is given.
 *
 * Tiled here rather than asked of ffmpeg's `tile` filter: that one waits for a
 * full grid before it writes anything, so a clip whose sampled frame count
 * lands one short produces no sheet at all and the run fails at its first
 * step. Each frame is written on its own and stacked, which always leaves a
 * picture.
 * @param clip - absolute path of the reference clip.
 * @param duration - its length in seconds.
 * @param stamp - what makes the scratch files unique.
 * @returns the absolute path of the sheet.
 */
async function contactSheet(clip: string, duration: number, stamp: string): Promise<string> {
  const last = Math.max(0, duration - 0.05)
  const moments = Array.from({ length: SHEET_FRAMES }, (_unused, index) => ({
    at: Math.min((duration * index) / (SHEET_FRAMES - 1), last),
    tile: join(tmpdir(), `recreate-sheet-${stamp}-${String(index)}.png`),
  }))
  try {
    // A few at a time: six seeks into one file, each its own short ffmpeg.
    let failure: unknown
    const pulled = await mapWithConcurrency(moments, SHEET_CONCURRENCY, async ({ at, tile }) => {
      try {
        // A moment past the last decodable frame takes the clip's final one.
        await frameAt(clip, tile, { at, orLast: true, maxSide: SHEET_TILE_SIDE, timeoutMs: 90_000 })
      } catch (error: unknown) {
        failure ??= error
        throw error
      }
      return tile
    })
    if (failure !== undefined) throw failure
    const parts = pulled.filter((tile): tile is string => tile !== undefined)
    const rows = Math.ceil(parts.length / SHEET_COLUMNS)
    // The last row is filled with the final frame rather than left short:
    // hstack refuses inputs of a different count and vstack a hole.
    while (parts.length < rows * SHEET_COLUMNS) parts.push(parts[parts.length - 1] as string)
    const chains: string[] = []
    const labels: string[] = []
    for (let row = 0; row < rows; row += 1) {
      const rowParts = parts.slice(row * SHEET_COLUMNS, (row + 1) * SHEET_COLUMNS)
      const inputs = rowParts.map((_, column) => `[${String(row * SHEET_COLUMNS + column)}:v]`).join('')
      chains.push(`${inputs}hstack=inputs=${String(rowParts.length)}[row${String(row)}]`)
      labels.push(`[row${String(row)}]`)
    }
    chains.push(`${labels.join('')}vstack=inputs=${String(rows)}[sheet]`)
    const out = join(tmpdir(), `recreate-sheet-${stamp}.png`)
    // ffmpegTo removes a half-written sheet when the tiling fails.
    return await ffmpegTo(out, [
      '-v', 'error', '-y',
      ...parts.flatMap(part => ['-i', part]),
      '-filter_complex', chains.join(';'),
      '-map', '[sheet]', '-frames:v', '1', out,
    ], 120_000)
  } finally {
    await Promise.all(moments.map(async ({ tile }) => unlink(tile).catch(() => undefined)))
  }
}

/**
 * Read the reference clip: the opening frame, and the action that follows it.
 *
 * One call for both, because the model is looking at one sheet either way: a
 * second call would re-read the same tiles and cost another minute before the
 * first render starts.
 * @param ctx - the host context, for the vision route.
 * @param clip - absolute path of the reference clip.
 * @param duration - its length in seconds.
 * @param pixels - its size in pixels.
 * @param stamp - what makes the scratch files unique.
 * @param chosen - the model the composer's chip was showing.
 * @returns the reading, or undefined when nothing can look at a clip.
 * @throws {Error} when the model answered nothing usable about the opening frame.
 */
export async function readReferenceClip(
  ctx: ImagineHost,
  clip: string,
  duration: number,
  pixels: { readonly width: number; readonly height: number },
  stamp: string,
  chosen?: ModelRoute,
): Promise<ReferenceReading | undefined> {
  const eyes = eyesOf(ctx, chosen)
  if (eyes === undefined) return undefined
  const sheet = await contactSheet(clip, duration, stamp)
  try {
    const reply = await lookWith(
      eyes.vision,
      sheet,
      analysisInstruction(SHEET_FRAMES, pixels.width, pixels.height, duration),
      eyes.route,
    )
    if (reply === undefined) return undefined
    /*
     * The labels are read off the line starts, and a model that answers in
     * Markdown writes its own emphasis there (`**frame:**`): the markers are
     * dropped rather than letting a bold label read as a reply without one.
     */
    const clean = withoutLineMarks(reply.text)
    const frame = labelledValue(clean, 'frame', 'motion')
    const motion = labelledValue(clean, 'motion', null)
    // A reply that ignored the two labels is still a description of the clip:
    // the frame is drawn from it rather than losing the run, and the render
    // falls back to the user's own line for the action.
    const body = frame ?? clean.trim()
    if (frame === undefined) {
      // The labels are missed and the paragraph carries the description alone:
      // that still draws the frame, and it is worth a line because the action
      // of the clip then comes from the user's own words.
      console.warn(`[imagine] recreate video: no frame/motion labels (${String(clean.trim().length)} characters), using the whole text as the shot description`)
    }
    if (body.length < 40) {
      console.warn(`[imagine] recreate video: description of ${String(body.length)} characters, too short: the frame is redrawn from the user's request`)
      return undefined
    }
    /*
     * The persona paragraph goes in front of the description HERE, not in the
     * instruction. Without it the graph draws the woman of the reference clip
     * instead of the deployment's person — measured 2026-10-24 on the first
     * version of this action, which asked for a good description and got a good
     * stranger. The hair is pinned (`pinHair`) so that the persona's own hair
     * wins whenever the reference's disagrees.
     */
    return { frame: pinHair(`${activePersona().identity} ${body}`), ...motion === undefined ? {} : { motion } }
  } finally {
    await unlink(sheet).catch(() => undefined)
  }
}

/**
 * Draw the reference clip's opening frame with Krea 2.
 *
 * The picture stays in the gallery: it is what the new clip starts from, and
 * when a recreation comes back wrong it is the first thing to look at.
 * @param ctx - the host context, for the ComfyUI client.
 * @param workflow - the configured Krea 2 graph.
 * @param outputDir - the media output directory.
 * @param frame - the description the reading wrote (`paragraph`), the size to
 *   draw at from the clip's own ratio (`canvas`), the job the file is declared
 *   under, the candidate's number when a set is drawn (`index`), the job's
 *   recipe (`quality`, `speed`) and its prompt-id callback and cancellation.
 * @returns the absolute path of the drawn frame.
 * @throws {Error} when the graph produced no picture.
 */
export async function drawOpeningFrame(
  ctx: ImagineHost,
  workflow: LoadedWorkflow,
  outputDir: string,
  frame: {
    readonly paragraph: string
    readonly canvas?: { readonly width: number; readonly height: number }
    readonly jobId: string
    readonly index?: number
    readonly quality?: ImagineQuality | undefined
    readonly speed?: ImagineSpeed | undefined
    readonly onPrompt?: (promptId: string) => void
    readonly signal?: AbortSignal
  },
): Promise<string> {
  const drawn = await drawKrea(ctx, workflow, outputDir, {
    prompt: frame.paragraph,
    ...frame.canvas === undefined ? {} : { canvas: frame.canvas },
    // The index is in the declared name when a set is drawn: without it every
    // candidate would declare the same file and land as `-2`, `-3`… .
    declared: declaredOutputPath(outputDir, 'recreate_frame', 'webp', {
      id: frame.jobId, ...frame.index === undefined ? {} : { candidate: frame.index },
    }),
    ...frame.quality === undefined ? {} : { quality: frame.quality },
    ...frame.speed === undefined ? {} : { speed: frame.speed },
    ...frame.onPrompt === undefined ? {} : { onPrompt: frame.onPrompt },
    ...frame.signal === undefined ? {} : { signal: frame.signal },
  })
  if (drawn === undefined) throw new Error(message('recreate.noFirstFrame'))
  return drawn
}

/**
 * The brief the H3 prompt is written from: the reference clip's action, then
 * the user's own line.
 *
 * The analysis comes first because it is the scene to recreate; what the user
 * wrote is a direction on top of it ("falla ballare", "gira la camera a
 * sinistra"), and a writer handed only the direction has no scene.
 * @param ask - the line the user typed, possibly empty.
 * @param motion - what the reading said happens over the reference clip.
 * @returns the brief, in the language the writer reads.
 */
export function recreateBrief(ask: string, motion: string | undefined): string {
  const lines = [
    'Film this scene again, taken from a reference video. The reference take, from its first frame to its last:',
    motion ?? '(no description of the movement: follow the user\'s direction)',
  ]
  const own = ask.trim()
  if (own.length > 0) lines.push('', `The user's direction, to be followed to the letter: ${own}`)
  return lines.join('\n')
}
