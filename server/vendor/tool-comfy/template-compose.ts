/**
 * The compositions of a template: the runs that are not a job.
 *
 * Grok's models do not all end in a graph. A collage, the photo-booth strip, a
 * still put on another canvas, a poster with the user's own words on it: those
 * are ffmpeg's, with no AI in the middle, and they come out the moment the
 * request is answered instead of twenty minutes later.
 *
 * The steps arrive already decided ({@link PlanCompose}): which photos, which
 * canvas, which way a photo meets a canvas of another ratio, the words. This
 * module turns one of those into a PNG in the media folder and nothing else —
 * the queue, the project and the chains are `template-jobs.ts`'s.
 *
 * Four rules hold the four layouts together:
 * - every photo is treated the same way, so a grid of mixed shots still reads
 *   as a grid (`scale` to cover, `crop` to the cell);
 * - the canvas is never bigger than {@link TOTAL_SIDE}, so a layout cannot ask
 *   ffmpeg for a 8000-pixel picture nobody can look at;
 * - an output that ffmpeg writes but cannot be read back is a failure, not a
 *   file: the caller gets a sentence it can show, never a broken tile;
 * - the final name is reserved first (an exclusive create, so two runs at once
 *   cannot pick the same one), ffmpeg writes a dot-prefixed file beside it
 *   (`listGallery` skips those) and the finished picture is renamed over the
 *   reservation: the gallery never lists a half-written PNG.
 * @module tool-comfy/template-compose
 */

import { randomBytes } from 'node:crypto'
import { mkdtemp, open, writeFile } from 'node:fs/promises'
import { renameWithRetry, rmWithRetry } from '../retry-fs/index.ts'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import type { PlanCompose } from '../../../shared/imagine-templates.ts'
import { labelRatio } from '../../../shared/imagine-media.ts'
import { message } from '../../src/messages.ts'
import { probePixels } from './gallery.ts'
import { declaredOutputPath } from './index.ts'
import { ffmpegTo } from './media-tools.ts'

/** The space between two cells of a grid, and between two photos of a strip. */
const GAP = 24

/** The white margin around a photo-booth strip. */
const STRIP_MARGIN = 40

/** The short side of one grid cell, before the total ceiling brings it down. */
const CELL_SIDE = 512

/** The longest side — and so the whole canvas — of any composition. */
const TOTAL_SIDE = 2048

/** The short side of a photo put on a canvas of another ratio. */
const CANVAS_SHORT_SIDE = 1080

/**
 * The narrowest a photo-booth strip may get, and the widest. Below the
 * narrowest the strip keeps fewer photos instead of shrinking further: the
 * {@link TOTAL_SIDE} ceiling holds either way.
 */
const STRIP_MIN_WIDTH = 64
const STRIP_MAX_WIDTH = 1024

/** The two faces of the text layouts: the headline in bold, the rest in regular. */
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
const FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

/**
 * The size of each line, as a share of the canvas width: the headline, the
 * middle line, the fine print. A layout draws three lines at most; a fourth
 * is not drawn.
 */
const LINE_SHARES = [12, 18, 26] as const

/** How wide a character is, as a share of the font size: an estimate good enough to wrap by. */
const CHARACTER_SHARE = 0.55

/** ffmpeg is local work on files it already has: a minute is generous, five is a fault. */
const COMPOSE_TIMEOUT_MS = 5 * 60_000

/** A composed photo: what a layout needs to know about a source picture. */
interface SourceSize {
  readonly width: number
  readonly height: number
}

/** One line of text, its size, and where it sits on the canvas. */
interface TextBlock {
  /** Which of the step's lines it is (0 the headline): the size and the face follow it. */
  readonly position: number
  /** Top edge, in pixels, of the first drawn line. */
  readonly top: number
  /** How tall the whole line is, wrapped rows included. */
  readonly height: number
  /** The font size. */
  readonly size: number
  /** The rows the line was wrapped into. */
  readonly rows: readonly string[]
}

/**
 * A composition's options: where the files are and what may feed the layout.
 * @property outputDir - the gallery folder: sources are read from it and the result is written there.
 * @property sourceName - the file the step before produced, when the layout continues a chain.
 */
export interface ComposeOptions {
  readonly outputDir: string
  readonly sourceName?: string
}

/**
 * Compose one planned layout into the gallery, with no model involved.
 * @param step - the layout, its files, canvas, fit and words, already resolved.
 * @param opts - the output folder and the file a chain continues from.
 * @returns the basename of the PNG written in `opts.outputDir`.
 * @throws {Error} a sentence for the user when the files cannot be read, when
 *   ffmpeg fails, or when what it wrote is not a picture.
 */
export async function composeTemplate(step: PlanCompose, opts: ComposeOptions): Promise<string> {
  // A step that continues a chain reads the file the chain hands it, and
  // nothing else; the others read their own gallery files.
  const named = step.fromPrevious === true
    ? (opts.sourceName === undefined ? [] : [opts.sourceName])
    : step.files
  if (named.length === 0) throw new Error(message('template.nothingToRun'))
  const sizes = step.layout === 'strip' ? await sizesOf(opts.outputDir, named) : undefined
  // A strip too long for the ceiling keeps the photos that fit.
  const strip = sizes === undefined ? undefined : stripLayout(sizes)
  const files = strip === undefined ? named : named.slice(0, strip.heights.length)
  const args = { layout: step.layout, files, aspect: step.aspectRatio, fit: step.fit, columns: step.columns, lines: step.lines }
  const out = await reserveOutputPath(declaredOutputPath(opts.outputDir, `template_${step.layout}`, 'png', args))
  const temp = join(dirname(out), `.${basename(out, extname(out))}-${randomBytes(4).toString('hex')}.png`)
  // The words are handed to `drawtext` through a file of their own: its
  // argument parser reads `:` `,` `'` and `%` as syntax, and a headline with
  // an apostrophe or a comma is ordinary text, not a filter.
  const scratch = await mkdtemp(join(tmpdir(), 'imagine-compose-'))
  try {
    try {
      const filter = step.layout === 'grid'
        ? gridFilter(files.length, step.columns, step.background)
        : strip !== undefined
          ? stripFilter(strip, step.background)
          : step.layout === 'text'
            ? await textFilter(step, opts.outputDir, files[0] as string, scratch)
            : await resizeFilter(step, opts.outputDir, files[0] as string)
      await ffmpegTo(temp, ffmpegArgs(files, opts.outputDir, filter, temp), COMPOSE_TIMEOUT_MS)
    } catch (error: unknown) {
      throw new Error(message('template.composeFailed', { reason: reasonOf(error) }))
    }
    // A file ffmpeg wrote and nothing can read is not a composition: the tile
    // would sit on the board broken, with no error anywhere.
    const pixels = await probePixels(temp, 'image')
    if (!('width' in pixels) || pixels.width <= 0 || pixels.height <= 0) {
      throw new Error(message('template.composeFailed', { reason: message('still.sizeUnreadable') }))
    }
    await renameWithRetry(temp, out)
  } catch (error: unknown) {
    // Neither the half-written picture nor the empty reservation stays behind.
    await rmWithRetry(temp, { force: true }).catch(() => undefined)
    await rmWithRetry(out, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await rmWithRetry(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
  return basename(out)
}

/**
 * Reserve an output name: the declared one, or a numbered neighbour when a
 * file already holds it.
 *
 * The reservation is an exclusive create (`wx`): checking that a name is free
 * and writing it later let two compositions of the same values, started
 * together, both pick it and the second overwrite the first. The empty file
 * stays until the finished picture is renamed over it.
 * @param declared - the absolute path the composition declared.
 * @returns the path reserved, an empty file that is now this call's.
 * @throws {Error} when no free name is found, or the folder cannot be written.
 */
export async function reserveOutputPath(declared: string): Promise<string> {
  const ext = extname(declared)
  const stem = declared.slice(0, declared.length - ext.length)
  // Bounded as `freeOutputPath` is: hundreds of same-stem files mean something
  // else is filling the folder.
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? declared : `${stem}-${String(n)}${ext}`
    try {
      const handle = await open(candidate, 'wx')
      await handle.close()
      return candidate
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error(message('file.noFreeName', { name: declared }))
}

/**
 * The ffmpeg command line for one composition: the photos, the filter graph
 * and the PNG to write.
 * @param files - the gallery basenames, in the order the layout wants them.
 * @param outputDir - the folder they (and the result) live in.
 * @param filter - the `-filter_complex` graph, ending in `[out]`.
 * @param out - the file to write.
 * @returns the arguments after `ffmpeg`.
 */
function ffmpegArgs(files: readonly string[], outputDir: string, filter: string, out: string): readonly string[] {
  return [
    '-y',
    ...files.flatMap(name => ['-i', join(outputDir, name)]),
    '-filter_complex', filter,
    '-map', '[out]',
    '-frames:v', '1',
    out,
  ]
}

/**
 * The grid: equal square cells, the photos cropped to fill them, the empty
 * cells of the last row left in the step's own colour.
 *
 * The first input is the colour canvas, so the output keeps the planned size
 * even when the last row is short — a `xstack` of three cells would shrink the
 * picture to the cells it actually placed.
 * @param count - how many photos.
 * @param columns - photos per row; absent, the shape closest to a square.
 * @param background - the colour behind the gaps and the empty cells.
 * @returns the filter graph.
 */
function gridFilter(count: number, columns: number | undefined, background: string): string {
  const shape = gridShape(count, columns)
  const cell = shape.cell
  const width = shape.columns * cell + GAP * (shape.columns - 1)
  const height = shape.rows * cell + GAP * (shape.rows - 1)
  const parts = [
    `color=c=${colourOf(background)}:s=${width}x${height}:d=1[base]`,
    ...Array.from({ length: count }, (_unused, index) =>
      `[${index}:v]scale=${cell}:${cell}:force_original_aspect_ratio=increase,crop=${cell}:${cell},setsar=1[cell${index}]`),
  ]
  let previous = '[base]'
  for (let index = 0; index < count; index++) {
    const x = (index % shape.columns) * (cell + GAP)
    const y = Math.floor(index / shape.columns) * (cell + GAP)
    const label = index === count - 1 ? '[out]' : `[row${index}]`
    parts.push(`${previous}[cell${index}]overlay=${x}:${y}${label}`)
    previous = `[row${index}]`
  }
  return parts.join(';')
}

/**
 * The shape of a grid: how many columns and rows, and how big one cell is.
 *
 * The cell starts at {@link CELL_SIDE} and shrinks when the grid would pass
 * {@link TOTAL_SIDE} either way, so a ten-photo collage stays viewable.
 * @param count - how many photos.
 * @param asked - the columns the step asked for.
 * @returns the columns, the rows and the cell's side, all at least 1/64 pixels.
 */
function gridShape(count: number, asked: number | undefined): { columns: number; rows: number; cell: number } {
  const columns = Math.max(1, Math.min(count, Math.round(asked ?? Math.ceil(Math.sqrt(count)))))
  const rows = Math.max(1, Math.ceil(count / columns))
  const fitted = Math.min(
    CELL_SIDE,
    (TOTAL_SIDE - GAP * (columns - 1)) / columns,
    (TOTAL_SIDE - GAP * (rows - 1)) / rows,
  )
  return { columns, rows, cell: Math.max(64, Math.floor(fitted)) }
}

/** A photo-booth strip, measured: its width and the height of each photo kept. */
export interface StripLayout {
  /** The width every photo is scaled to. */
  readonly width: number
  /** The height of each photo kept, top to bottom; fewer than given when the rest did not fit. */
  readonly heights: readonly number[]
}

/**
 * Measure a photo-booth strip: one column, the photos at the same width, each
 * in its own proportion, inside {@link TOTAL_SIDE} tall margins and gaps
 * included.
 *
 * The width is as wide as it can be while the whole strip still fits, up to
 * {@link STRIP_MAX_WIDTH}. When even {@link STRIP_MIN_WIDTH} would be too
 * tall, the strip keeps the first photos that fit at that width (one at
 * least, scaled down to fit) instead of a picture past the ceiling. The
 * heights are rounded down, so their sum never passes the room there is.
 * @param sizes - the photos' sizes, top to bottom.
 * @returns the width and the kept photos' heights.
 */
export function stripLayout(sizes: readonly SourceSize[]): StripLayout {
  const ratios = sizes.map(size => size.height / size.width)
  const room = (count: number): number => TOTAL_SIDE - 2 * STRIP_MARGIN - GAP * (count - 1)
  const tallness = (count: number): number => ratios.slice(0, count).reduce((total, ratio) => total + ratio, 0)
  let count = ratios.length
  while (count > 1 && room(count) / tallness(count) < STRIP_MIN_WIDTH) count -= 1
  const fitted = Math.floor(room(count) / tallness(count))
  const width = Math.max(2, Math.min(STRIP_MAX_WIDTH, fitted - (fitted % 2)))
  return { width, heights: ratios.slice(0, count).map(ratio => Math.max(2, Math.floor(width * ratio))) }
}

/**
 * The photo-booth strip's filter: the photos at the measured width, white
 * gaps between them and white margins all round.
 * @param strip - the measured strip ({@link stripLayout}).
 * @param background - the colour of the gaps and the margins.
 * @returns the filter graph.
 */
function stripFilter(strip: StripLayout, background: string): string {
  const colour = colourOf(background)
  const last = strip.heights.length - 1
  // The gap is white like the margin: the last photo does not carry one, or
  // the bottom margin would read twice as thick as the top. Each photo is
  // scaled to its measured box, so the total is the one `stripLayout` fitted.
  const parts = strip.heights.map((height, index) => {
    const gap = index === last ? '' : `,pad=${strip.width}:ih+${GAP}:0:0:color=${colour}`
    return `[${index}:v]scale=${strip.width}:${height},setsar=1${gap}[strip${index}]`
  })
  parts.push(`${strip.heights.map((_height, index) => `[strip${index}]`).join('')}vstack=inputs=${strip.heights.length}[stacked]`)
  parts.push(`[stacked]pad=iw+${2 * STRIP_MARGIN}:ih+${2 * STRIP_MARGIN}:${STRIP_MARGIN}:${STRIP_MARGIN}:color=${colour}[out]`)
  return parts.join(';')
}

/**
 * The sizes of the photos a layout reads.
 * @param outputDir - the gallery folder.
 * @param files - the photos.
 * @returns their sizes, in order.
 */
async function sizesOf(outputDir: string, files: readonly string[]): Promise<readonly SourceSize[]> {
  const sizes: SourceSize[] = []
  for (const name of files) sizes.push(await sizeOf(outputDir, name))
  return sizes
}

/**
 * A still put on a canvas of another ratio: cropped to fill it, or laid on the
 * step's colour with its whole frame kept.
 * @param step - the step, for the canvas and the fit.
 * @param outputDir - the gallery folder.
 * @param name - the photo.
 * @returns the filter graph.
 */
async function resizeFilter(step: PlanCompose, outputDir: string, name: string): Promise<string> {
  const size = await sizeOf(outputDir, name)
  const canvas = canvasSize(step.aspectRatio === undefined ? size.width / size.height : ratioOf(step.aspectRatio))
  return `[0:v]${fitFilter(canvas, step.fit, step.background)},setsar=1[out]`
}

/**
 * The poster: a still on a canvas of the step's ratio, and the user's own
 * words over a dark band from the top, the headline first and biggest.
 *
 * `drawtext` gets each line from a file of its own with `expansion=none`: the
 * words are the user's, so nothing in them may be read as filter syntax.
 * @param step - the step, for the canvas, the fit and the lines.
 * @param outputDir - the gallery folder.
 * @param name - the photo.
 * @param scratch - a temporary folder for the text files.
 * @returns the filter graph.
 */
async function textFilter(step: PlanCompose, outputDir: string, name: string, scratch: string): Promise<string> {
  const size = await sizeOf(outputDir, name)
  const canvas = canvasSize(step.aspectRatio === undefined ? size.width / size.height : ratioOf(step.aspectRatio))
  const parts = [`[0:v]${fitFilter(canvas, step.fit, step.background)},setsar=1[canvas]`]
  const blocks = textBlocks(step.lines, canvas.width, canvas.height)
  if (blocks.length === 0) {
    parts.push('[canvas]null[out]')
    return parts.join(';')
  }
  const pad = Math.round(canvas.width * 0.03)
  const bandTop = Math.max(0, Math.min(...blocks.map(block => block.top)) - pad)
  const bandEnd = Math.min(canvas.height, Math.max(...blocks.map(block => block.top + block.height)) + pad)
  parts.push(`[canvas]drawbox=x=0:y=${bandTop}:w=iw:h=${bandEnd - bandTop}:color=black@0.45:t=fill[band]`)
  let previous = '[band]'
  for (const [index, block] of blocks.entries()) {
    const file = join(scratch, `line-${index}.txt`)
    await writeFile(file, block.rows.join('\n'), 'utf8')
    const label = index === blocks.length - 1 ? '[out]' : `[line${index}]`
    parts.push(`${previous}drawtext=fontfile=${block.position === 0 ? FONT_BOLD : FONT_REGULAR}:textfile=${file}`
      + `:expansion=none:fontsize=${block.size}:fontcolor=white:line_spacing=${Math.round(block.size * 0.25)}`
      + `:x=(w-text_w)/2:y=${block.top}${label}`)
    previous = `[line${index}]`
  }
  return parts.join(';')
}

/**
 * The lines of a poster, wrapped and placed: the first at the top, the second
 * under it, the third under that.
 *
 * Downwards, and not up from the bottom, because the words are read in the
 * order the form asked them: a product card says its first benefit first, and
 * a poster says its headline before its fine print. It is also the half of the
 * frame the editorial model is asked to leave open for them.
 *
 * The wrapping is an estimate — a character is about {@link CHARACTER_SHARE}
 * of the font size — because the exact width is known only after `drawtext`
 * has shaped the text, and a band that waits for that cannot be drawn behind
 * it.
 *
 * A line left empty is not drawn and takes no room, but it keeps its place:
 * the second line is drawn at the second size even when the first is empty,
 * so a card without a first benefit does not turn its second into a headline.
 * @param lines - the words, already resolved by the engine and already short,
 *   one per line the step names (an empty string for a box left empty).
 * @param width - the canvas width.
 * @param height - the canvas height.
 * @returns the blocks, first line first; empty when there are no words.
 */
export function textBlocks(lines: readonly string[], width: number, height: number): readonly TextBlock[] {
  const margin = Math.round(width * 0.06)
  const usable = width - 2 * margin
  let top = Math.round(height * 0.05)
  const blocks: TextBlock[] = []
  for (const [index, text] of [...lines].slice(0, LINE_SHARES.length).entries()) {
    if (text.trim().length === 0) continue
    const size = Math.max(18, Math.round(width / (LINE_SHARES[index] ?? 26)))
    const perRow = Math.max(8, Math.floor(usable / (size * CHARACTER_SHARE)))
    const rows = wrapWords(text, perRow)
    const blockHeight = Math.round(rows.length * size * 1.25)
    blocks.push({ position: index, top, height: blockHeight, size, rows })
    top += blockHeight + Math.round(size * 0.4)
  }
  return blocks
}

/**
 * One line wrapped into rows that each fit the estimated width.
 * @param text - the words.
 * @param perRow - the estimated characters per row.
 * @returns the rows; a word longer than a row keeps a row of its own.
 */
function wrapWords(text: string, perRow: number): readonly string[] {
  const words = text.split(/\s+/).filter(word => word.length > 0)
  const rows: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (current.length === 0 || candidate.length <= perRow) {
      current = candidate
      continue
    }
    rows.push(current)
    current = word
  }
  if (current.length > 0) rows.push(current)
  return rows.length === 0 ? [''] : rows
}

/**
 * The scale-and-place part of a single-photo layout: cover and crop to fill,
 * or contain and border with the step's colour.
 * @param canvas - the canvas to fill.
 * @param fit - which of the two the step asked for.
 * @param background - the colour behind a padded photo.
 * @returns the filter chain, without its input and output labels.
 */
function fitFilter(canvas: SourceSize, fit: 'fill' | 'pad', background: string): string {
  const box = `${canvas.width}:${canvas.height}`
  if (fit === 'pad') {
    return `scale=${box}:force_original_aspect_ratio=decrease,pad=${box}:(ow-iw)/2:(oh-ih)/2:color=${colourOf(background)}`
  }
  /*
   * The crop of a `fill` keeps the top of the photo, not its middle: a person
   * cut from a portrait to a wide frame who is cropped at the centre loses the
   * head, and the head is what the picture is about. A quarter of the excess
   * stays above, so there is room over the hair, and the rest is taken off the
   * bottom.
   */
  return `scale=${box}:force_original_aspect_ratio=increase,crop=${box}:(iw-ow)/2:(ih-oh)*0.25`
}

/**
 * A canvas of this ratio, at a short side of {@link CANVAS_SHORT_SIDE} and
 * never past {@link TOTAL_SIDE} the long way.
 * @param ratio - width ÷ height.
 * @returns the pixel size, both sides even.
 */
function canvasSize(ratio: number): SourceSize {
  const wide = ratio >= 1
  let width = wide ? Math.round(CANVAS_SHORT_SIDE * ratio) : CANVAS_SHORT_SIDE
  let height = wide ? CANVAS_SHORT_SIDE : Math.round(CANVAS_SHORT_SIDE / ratio)
  if (width > TOTAL_SIDE) {
    width = TOTAL_SIDE
    height = Math.round(TOTAL_SIDE / ratio)
  }
  if (height > TOTAL_SIDE) {
    height = TOTAL_SIDE
    width = Math.round(TOTAL_SIDE * ratio)
  }
  return { width: even(width), height: even(height) }
}

/** The nearest even number, which is what the encoders want. */
function even(value: number): number {
  return value % 2 === 0 ? value : value + 1
}

/**
 * The width ÷ height of an aspect written as `16:9`.
 * @param aspect - the value the engine resolved.
 * @returns the ratio; a value that is not an aspect is read as a square.
 */
function ratioOf(aspect: string): number {
  const ratio = labelRatio(aspect)
  return ratio === undefined || ratio <= 0 ? 1 : ratio
}

/**
 * A colour as ffmpeg writes it (`#ffffff` → `0xffffff`).
 * @param colour - the step's colour, `#rrggbb` or a name ffmpeg knows.
 * @returns the value to put in a filter.
 */
function colourOf(colour: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(colour) ? `0x${colour.slice(1)}` : colour
}

/**
 * The size of a source photo, which the canvas and the strip widths are read
 * from.
 * @param outputDir - the gallery folder.
 * @param name - the photo.
 * @returns its pixel size.
 * @throws {Error} when the photo's header cannot be read.
 */
async function sizeOf(outputDir: string, name: string): Promise<SourceSize> {
  const pixels = await probePixels(join(outputDir, name), 'image')
  if (!('width' in pixels) || pixels.width <= 0 || pixels.height <= 0) {
    throw new Error(message('template.composeFailed', { reason: `${name}: ${message('still.sizeUnreadable')}` }))
  }
  return { width: pixels.width, height: pixels.height }
}

/**
 * Why ffmpeg refused, in one short line.
 *
 * `execFile`'s message is the whole command line, which is neither readable
 * nor useful in a studio error: the last line of what the process wrote is the
 * one that says it.
 * @param error - what was thrown.
 * @returns the reason, cut to a sentence's length.
 */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  return (lines.at(-1) ?? message('file.notFound')).slice(0, 200)
}
