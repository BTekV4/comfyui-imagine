/**
 * The mask of a zone edit: the thing's own outline when the zone was grounded
 * on a name, a rounded rectangle otherwise.
 *
 * A rectangle is what the graph used to get, and the graph redraws everything
 * it covers at denoise 1: on a structured background (a wooden table under a
 * cup) the wood inside the box was invented and the edge read as a frame. The
 * zone edit now asks SAM 3 for the object the grounding pass found and hands
 * the graph that shape, so the background around the object is never part of
 * the redraw. A rectangle the user marked keeps its shape — that is the zone
 * they asked for — but its corners are rounded and its edge is feathered in
 * proportion to its size, instead of the fixed 16/24 px the graph was saved
 * with.
 *
 * The grow and blur are written on the graph's own `ImagineGrowMask` nodes for
 * the run (`RegionEdges`), because the loudest one works in the crop's pixels
 * and the other in the photo's: one number cannot serve both, and the 16 px
 * that suits a 300 px cup eats a 60 px ring off a button.
 * @module tool-comfy/region-mask
 */

import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import type { ImagineRegion } from '../../../shared/imagine-types.ts'
import type { ImagineSegment, ImagineSegmentsIndex } from '../../../shared/imagine-segments.ts'
import type { LoadedWorkflow } from './index.ts'
import { rmWithRetry } from '../retry-fs/index.ts'
import { ffmpegTo } from './media-tools.ts'
import { samRunForTarget, segmentsDir, storedSegments } from './segments.ts'

/** How much the mask is grown on every side, as a share of its short side. */
const GROW_SHARE = 0.025

/** How soft the mask's edge is, as a share of its short side (Gaussian sigma). */
const BLUR_SHARE = 0.02

/** The corner radius of a fallback rectangle, as a share of its short side. */
const CORNER_SHARE = 0.07

/** Smallest and largest grow the graph is written with, in pixels. */
const GROW_RANGE = { min: 2, max: 96, cropMax: 192 } as const

/** Smallest and largest blur the graph is written with, in pixels. */
const BLUR_RANGE = { min: 2, max: 72, cropMax: 128 } as const

/**
 * The shares of a mask that pass as the thing the box was drawn around.
 *
 * `SEGMENT_MIN_IOU` is the mask's box against the grounding box; `cover` is
 * how much of the mask falls inside that box (a table under the cup spills
 * out), `fill` how much of the box the mask takes (a handle is not the cup).
 */
const SEGMENT_MIN_IOU = 0.25
const SEGMENT_MIN_COVER = 0.4
const SEGMENT_MIN_FILL = 0.1

/** Words too common to say what a thing is, in the two languages the studio writes. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'with',
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'del', 'dello', 'della', 'dei', 'degli', 'delle',
  'da', 'dal', 'dallo', 'dalla', 'in', 'con', 'su', 'sul', 'sullo', 'sulla', 'per', 'e', 'o',
])

/** Grow and softness written on one `ImagineGrowMask` node. */
export interface EdgeAmount {
  readonly expand: number
  readonly blur: number
}

/** The two grow nodes of the zone graph, each in its own pixels. */
export interface RegionEdges {
  /** The node that softens the mask on the photo (`603` in the shipped graph). */
  readonly photo: EdgeAmount
  /** The node that softens it on the crop the sampler sees (`610`). */
  readonly crop: EdgeAmount
}

/** What a zone mask was made from, for the log and the tests. */
export type ZoneMaskSource = 'segment' | 'sam' | 'rectangle'

/** The mask written and the edges the graph is to use with it. */
export interface ZoneMask {
  readonly source: ZoneMaskSource
  readonly edges: RegionEdges
}

/** A segment that fits the box, with the measures that made it win. */
export interface SegmentChoice {
  readonly segment: ImagineSegment
  readonly iou: number
}

/** A width and height in the mask's own pixels. */
interface BoxSize {
  readonly w: number
  readonly h: number
}

/**
 * The `ImagineInpaintCrop` settings the crop-space edges are scaled with.
 * @param workflow - the graph the run will use.
 * @returns the context factor and target size the graph declares, or the
 *   shipped graph's own when it has no crop node.
 */
export function cropSettings(workflow: LoadedWorkflow): { readonly contextFactor: number; readonly targetSize: number } {
  for (const node of Object.values(workflow.graph)) {
    if (node.class_type !== 'ImagineInpaintCrop') continue
    const factor = node.inputs.context_factor
    const target = node.inputs.target_size
    return {
      contextFactor: typeof factor === 'number' && factor > 0 ? factor : 2.5,
      targetSize: typeof target === 'number' && target > 0 ? target : 1536,
    }
  }
  return { contextFactor: 2.5, targetSize: 1536 }
}

/** One proportional amount, rounded and kept inside its range. */
function share(amount: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(amount)))
}

/**
 * The grow and blur each of the two nodes gets for a mask of this size.
 *
 * The share is of the mask's SHORT side, so a long thin thing (a pole, a
 * caption) is not grown by the length of the photo. The crop node works on
 * the crop after it was resized to `target_size`, so its pixels are converted
 * with the crop's own scale — roughly `target_size / (context_factor × the
 * mask's long side)`.
 * @param box - the mask's bounding box, in photo pixels.
 * @param contextFactor - the crop's context multiplier.
 * @param targetSize - the crop's long side after resizing (0 keeps it).
 * @returns the two nodes' amounts.
 */
export function regionEdgesFor(box: BoxSize, contextFactor: number, targetSize: number): RegionEdges {
  const short = Math.max(1, Math.min(box.w, box.h))
  const expand = share(short * GROW_SHARE, GROW_RANGE.min, GROW_RANGE.max)
  const blur = share(short * BLUR_SHARE, BLUR_RANGE.min, BLUR_RANGE.max)
  const longSide = Math.max(1, Math.max(box.w, box.h)) * Math.max(1, contextFactor)
  const scale = targetSize > 0 ? targetSize / longSide : 1
  return {
    photo: { expand, blur },
    crop: {
      expand: share(expand * scale, 1, GROW_RANGE.cropMax),
      // A half-pixel step: `blur_radius` is a float on the node.
      blur: Math.min(BLUR_RANGE.cropMax, Math.max(1, Math.round(blur * scale * 2) / 2)),
    },
  }
}

/** The words worth matching between a target and a segment's label. */
function wordsOf(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3 && !STOP_WORDS.has(word)))
}

/**
 * Whether a segment's label names the target (or the other way round).
 *
 * Only a tie-break: the labels are English (the vision pass writes them) and
 * the user's word may be Italian, so the box is what really chooses. When
 * they do share a word ("cup" / "coffee cup") it is worth preferring.
 */
function labelsMatch(label: string, target: string | undefined): boolean {
  if (target === undefined) return false
  const named = wordsOf(target)
  if (named.size === 0) return false
  for (const word of wordsOf(label)) if (named.has(word)) return true
  return false
}

/** The area of the intersection of two pixel boxes. */
function intersection(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

/**
 * The segment that is the thing inside a grounding box.
 *
 * The box came from the vision model, the masks from SAM 3: the one that fits
 * is the object, while the table under it spills out of the box (low `cover`)
 * and a handle or a saucer takes too little of it (low `fill`). Text segments
 * are left out — their mask is a rectangle by construction, which is the very
 * shape this is here to avoid.
 * @param index - a photo's analysis.
 * @param region - the grounding box, as fractions of the photo.
 * @param target - the user's word for the thing, for the tie-break.
 * @returns the best fitting segment, or undefined when none fits.
 */
export function chooseSegment(
  index: ImagineSegmentsIndex,
  region: ImagineRegion,
  target?: string,
): SegmentChoice | undefined {
  const box = {
    x: region.x * index.width,
    y: region.y * index.height,
    w: region.w * index.width,
    h: region.h * index.height,
  }
  let best: (SegmentChoice & { readonly label: boolean; readonly score: number }) | undefined
  for (const segment of index.segments) {
    if (segment.kind !== 'object') continue
    const area = segment.bbox.w * segment.bbox.h
    if (area <= 0) continue
    const overlap = intersection(box, segment.bbox)
    if (overlap <= 0) continue
    const union = box.w * box.h + area - overlap
    const iou = union > 0 ? overlap / union : 0
    const cover = overlap / area
    const fill = overlap / (box.w * box.h)
    if (iou < SEGMENT_MIN_IOU || cover < SEGMENT_MIN_COVER || fill < SEGMENT_MIN_FILL) continue
    const label = labelsMatch(segment.label, target)
    const candidate = { segment, iou, label, score: segment.score }
    if (best === undefined || candidate.iou > best.iou
      || (candidate.iou === best.iou && candidate.label !== best.label && candidate.label)
      || (candidate.iou === best.iou && candidate.label === best.label && candidate.score > best.score)) {
      best = candidate
    }
  }
  return best === undefined ? undefined : { segment: best.segment, iou: best.iou }
}

/**
 * Write one of the stored masks at the photo's own size.
 *
 * The stored mask is already the photo's size; the scale is here for an
 * analysis made before the file was replaced, and nearest keeps the edge from
 * inventing half-tones the graph would then grow.
 */
async function writeStoredMask(source: string, width: number, height: number, path: string): Promise<void> {
  await ffmpegTo(path, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-vf', `scale=${String(width)}:${String(height)}:flags=neighbor,format=gray`,
    '-frames:v', '1', path,
  ], 60_000)
}

/**
 * The rounded-rectangle expression of the mask.
 *
 * `geq` paints a pixel white when it is inside the rounded box: the signed
 * distance of the rounded rectangle is the hypotenuse of the two distances
 * from the inner straight edges, compared with the radius. Written instead of
 * `drawbox` because that one cannot round its corners.
 * @param box - the rectangle, in photo pixels.
 * @param radius - the corner radius, in pixels.
 * @returns the luminance expression `geq` is given.
 */
export function roundedRectExpression(
  box: { readonly left: number; readonly top: number; readonly w: number; readonly h: number },
  radius: number,
): string {
  const r = Math.max(0, Math.min(radius, Math.floor(box.w / 2), Math.floor(box.h / 2)))
  const cx = box.left + box.w / 2
  const cy = box.top + box.h / 2
  const innerX = Math.max(0, box.w / 2 - r)
  const innerY = Math.max(0, box.h / 2 - r)
  return `if(lte(hypot(max(abs(X-${String(cx)})-${String(innerX)},0),max(abs(Y-${String(cy)})-${String(innerY)},0)),${String(r)}),255,0)`
}

/**
 * Painted mask of a rectangle the user marked: rounded corners, proportional
 * radius. The edge itself is softened by the graph's grow node, which gets
 * the proportional amount of {@link regionEdgesFor}.
 */
async function writeRoundedRegionMask(
  region: ImagineRegion,
  width: number,
  height: number,
  path: string,
): Promise<BoxSize> {
  const left = Math.max(0, Math.round(region.x * width))
  const top = Math.max(0, Math.round(region.y * height))
  const w = Math.max(1, Math.min(width - left, Math.round(region.w * width)))
  const h = Math.max(1, Math.min(height - top, Math.round(region.h * height)))
  const radius = share(Math.min(w, h) * CORNER_SHARE, 4, 64)
  await ffmpegTo(path, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=black:s=${String(width)}x${String(height)}`,
    '-vf', `format=gray,geq=lum='${roundedRectExpression({ left, top, w, h }, radius)}'`,
    '-frames:v', '1', path,
  ], 60_000)
  return { w, h }
}

/**
 * The SAM 3 mask of the target: from the photo's stored analysis when it has
 * one, else from a pass asked for the name alone.
 *
 * The stored analysis was made when the photo arrived and lists everything in
 * it; a photo that has none (an old file, or one whose analysis failed) still
 * deserves the object's outline, and asking SAM 3 for the one concept costs a
 * few seconds, not the vision pass's minute.
 * @returns the mask's box and where it came from, or undefined when no mask
 *   fits the box.
 */
async function samMaskOf(
  ctx: ImagineHost,
  outputDir: string,
  photo: string,
  region: ImagineRegion,
  target: string,
  width: number,
  height: number,
  path: string,
): Promise<{ readonly source: 'segment' | 'sam'; readonly box: BoxSize } | undefined> {
  const stored = await storedSegments(photo)
  const known = stored === undefined ? undefined : chooseSegment(stored, region, target)
  if (stored !== undefined && known !== undefined) {
    await writeStoredMask(join(segmentsDir(photo), known.segment.mask), width, height, path)
    return { source: 'segment', box: { w: known.segment.bbox.w, h: known.segment.bbox.h } }
  }
  const run = await samRunForTarget(ctx, outputDir, photo, target)
  try {
    const choice = chooseSegment(run.index, region, target)
    if (choice === undefined) return undefined
    await writeStoredMask(join(run.dir, choice.segment.mask), width, height, path)
    return { source: 'sam', box: { w: choice.segment.bbox.w, h: choice.segment.bbox.h } }
  } finally {
    await rmWithRetry(run.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Write the mask a zone edit runs with, and say how the graph must soften it.
 *
 * The order is: the grounded object's SAM 3 outline, then the rounded
 * rectangle. A SAM 3 pass that fails (no such thing, the node not installed,
 * ComfyUI busy) costs the run nothing but the few seconds it took: the
 * rectangle is the mask the studio always wrote, so a zone edit never fails
 * because of the way the mask was looked for.
 * @param ctx - the host: ComfyUI, for a SAM 3 pass.
 * @param workflow - the graph, for its crop settings.
 * @param outputDir - the gallery folder.
 * @param photo - the photo's basename.
 * @param region - the zone, as fractions of the photo.
 * @param target - the thing the zone was grounded on, when it has a name.
 * @param width - the photo's width in pixels.
 * @param height - the photo's height in pixels.
 * @param path - where the scratch PNG is written.
 * @returns what was written and the edges the two grow nodes take.
 */
export async function writeZoneMask(
  ctx: ImagineHost,
  workflow: LoadedWorkflow,
  outputDir: string,
  photo: string,
  region: ImagineRegion,
  target: string | undefined,
  width: number,
  height: number,
  path: string,
): Promise<ZoneMask> {
  const crop = cropSettings(workflow)
  if (target !== undefined && target.trim().length > 0) {
    try {
      const found = await samMaskOf(ctx, outputDir, photo, region, target, width, height, path)
      if (found !== undefined) {
        return { source: found.source, edges: regionEdgesFor(found.box, crop.contextFactor, crop.targetSize) }
      }
    } catch (error: unknown) {
      // A mask is an improvement, not the edit: say it in the log and write
      // the rectangle the run would have had before this existed.
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`[imagine] zone mask for ${photo}: ${reason.slice(0, 300)}`)
    }
  }
  const box = await writeRoundedRegionMask(region, width, height, path)
  return { source: 'rectangle', edges: regionEdgesFor(box, crop.contextFactor, crop.targetSize) }
}
