/**
 * «Segments»: the parts of a photo, as the server keeps them and the page
 * draws them (the panel of Grok Imagine's photo page, 2026-11-14).
 * @module shared/imagine-segments
 */

/** An object SAM 3 cut out, or a readable text the vision model found. */
export type ImagineSegmentKind = 'object' | 'text'

/** One part of the photo. Boxes are in the photo's pixels. */
export interface ImagineSegment {
  readonly index: number
  readonly kind: ImagineSegmentKind
  /** English noun phrase for an object ("coffee cup"), the words for a text. */
  readonly label: string
  /** SAM 3's confidence, 0-1; 0 for a text it could not place. */
  readonly score: number
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  /** Share of the photo the mask covers, 0-1. */
  readonly area: number
  /** File of the full-size mask (white = the part), under the photo's folder. */
  readonly mask: string
  /** File of the RGBA cut-out, cropped to the box. */
  readonly cut: string
}

/** One photo's analysis. */
export interface ImagineSegmentsIndex {
  /** The gallery file it was made from. */
  readonly photo: string
  readonly width: number
  readonly height: number
  /** ISO time of the analysis. */
  readonly createdAt: string
  /** The vision model that listed the parts, `provider/model`. */
  readonly model?: string
  readonly segments: readonly ImagineSegment[]
}

/** Where a photo's analysis stands, as `GET /api/segments?name=` answers. */
export type ImagineSegmentsStatus =
  | { readonly state: 'none' }
  | { readonly state: 'running'; readonly since: string }
  | { readonly state: 'ready'; readonly index: ImagineSegmentsIndex }
  | { readonly state: 'failed'; readonly error: string }

/**
 * The URL of one of a photo's segment files. The analysis time rides along:
 * a new analysis can reuse a file name, and the browser keeps these a day.
 */
export function segmentFileUrl(index: ImagineSegmentsIndex, file: string): string {
  return `/api/segments/file/${encodeURIComponent(index.photo)}/${encodeURIComponent(file)}?v=${encodeURIComponent(index.createdAt)}`
}

/** A run of segments with one label: Grok lists "ring" ×3 under one row. */
export interface SegmentGroup {
  readonly label: string
  readonly kind: ImagineSegment['kind']
  readonly members: readonly ImagineSegment[]
}

/**
 * The segments grouped by label, in the order the first of each came.
 * @param segments - the analysis' segments.
 * @returns the groups; a group of one is a plain row.
 */
export function groupSegments(segments: readonly ImagineSegment[]): readonly SegmentGroup[] {
  const groups = new Map<string, { label: string; kind: ImagineSegment['kind']; members: ImagineSegment[] }>()
  for (const segment of segments) {
    const key = `${segment.kind}\u001f${segment.label.toLowerCase()}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { label: segment.label, kind: segment.kind, members: [segment] })
    else group.members.push(segment)
  }
  return [...groups.values()]
}

/** The prompt Grok's bin puts in the edit box: the part is regenerated without itself. */
export const SEGMENT_REMOVE_PROMPT = 'remove this layer'

/** Grok's ten typefaces for a text part, with how the model is told about each. */
export const TEXT_EDIT_FONTS = [
  { id: 'serif-classic', words: 'a classic serif typeface' },
  { id: 'sans-geometric', words: 'a geometric sans-serif typeface' },
  { id: 'grotesque-bold', words: 'a bold grotesque sans-serif typeface' },
  { id: 'slab-serif', words: 'a slab serif typeface' },
  { id: 'condensed-impact', words: 'a condensed impact-style typeface' },
  { id: 'brush-script', words: 'a brush script typeface' },
  { id: 'calligraphy', words: 'an elegant calligraphy typeface' },
  { id: 'retro-rounded', words: 'a retro rounded typeface' },
  { id: 'marker', words: 'a hand-drawn marker typeface' },
  { id: 'blackletter', words: 'a blackletter (gothic) typeface' },
] as const

export type TextEditFont = typeof TEXT_EDIT_FONTS[number]['id']

/** What the text editor of a text part was set to. */
export interface TextEditDraft {
  /** The words the part should read. */
  readonly text: string
  /** `#rrggbb`, or undefined to keep the colour. */
  readonly color?: string
  readonly font?: TextEditFont
  /** Steps smaller (negative) or larger (positive). */
  readonly size: number
  readonly align?: 'left' | 'center' | 'right'
}

/**
 * The instruction a text part's edit sends: Grok sends the editor's fields
 * to its own pipeline; the region edit here takes one sentence, so the
 * fields become that sentence, the user's own words last.
 * @param original - the words the part reads now.
 * @param draft - the editor's fields.
 * @param extra - what the user typed under them.
 * @returns the prompt, or '' when nothing was changed or asked.
 */
export function textEditPrompt(original: string, draft: TextEditDraft, extra: string): string {
  const parts: string[] = []
  const words = draft.text.trim()
  if (words.length > 0 && words !== original) parts.push(`Replace the text "${original}" with "${words}", keeping its position, perspective and lighting.`)
  const restyle: string[] = []
  if (draft.color !== undefined) restyle.push(`colour ${draft.color}`)
  const font = TEXT_EDIT_FONTS.find(entry => entry.id === draft.font)
  if (font !== undefined) restyle.push(font.words)
  if (draft.size > 0) restyle.push(`${String(draft.size * 15)}% larger`)
  if (draft.size < 0) restyle.push(`${String(-draft.size * 15)}% smaller`)
  if (draft.align !== undefined) restyle.push(`${draft.align} aligned`)
  if (restyle.length > 0) parts.push(`Restyle the text "${words || original}": ${restyle.join(', ')}.`)
  const tail = extra.trim()
  if (tail.length > 0) parts.push(tail)
  return parts.join(' ')
}

/**
 * The names the cut-outs take in «Download all», as Grok's `segments.zip`:
 * `<label>.png` for a part alone, `<label>/<label>-N.png` for a group; the
 * label is lower-case, letters and digits joined by dashes ("object" when
 * nothing is left), and a name already taken gets `-2`, `-3`…
 * @param labels - the parts' labels, in order.
 * @returns one entry name per label.
 */
export function segmentZipNames(labels: readonly string[]): readonly string[] {
  const totals = new Map<string, number>()
  for (const label of labels) totals.set(label, (totals.get(label) ?? 0) + 1)
  const seenOf = new Map<string, number>()
  const taken = new Set<string>()
  const free = (name: string, n = 2): string => {
    if (!taken.has(name)) { taken.add(name); return name }
    const dot = name.lastIndexOf('.')
    return free(`${name.slice(0, dot)}-${String(n)}${name.slice(dot)}`, n + 1)
  }
  return labels.map((label) => {
    const slug = label.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase().replaceAll(/^-+|-+$/g, '') || 'object'
    const seen = seenOf.get(label) ?? 0
    seenOf.set(label, seen + 1)
    return free((totals.get(label) ?? 1) === 1 ? `${slug}.png` : `${slug}/${slug}-${String(seen + 1)}.png`)
  })
}
