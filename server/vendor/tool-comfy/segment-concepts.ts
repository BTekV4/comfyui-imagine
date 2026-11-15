/**
 * «Segmenti»: what is in a photo, named so SAM 3 can cut each thing out.
 *
 * Grok Imagine opens a photo with a list of its parts — "man with sunglasses",
 * "coffee cup", "ring", "white clouds" — and the readable text on it as parts
 * of their own. SAM 3 (the `ImagineSegments` node on ComfyUI) draws the masks,
 * but only for things it is told to look for: this module asks the vision
 * model for that list, once per photo.
 *
 * The objects go to SAM 3 as English noun phrases with a ceiling on how many
 * of each it may return. The texts do not: SAM finds "text", not a word, so
 * each one keeps the box the model gave it (0-1000 on both sides, as the
 * Qwen and GLM families answer) and becomes a rectangular segment.
 *
 * Measured on 2026-11-14 on a 1080×1080 photo: the default model
 * (strata/qwen3.8-flash-next) answers in 47 s with reasoning "low" and 157 s
 * without a level; glm-5.3-flash in 5-7 s. The user chose the single model
 * Imagine already uses, so the wait is long and the reply is kept.
 * @module tool-comfy/segment-concepts
 */

import type { ImagineHost } from '../../src/host.ts'
import { eyesOf } from './eyes.ts'
import { lookWith } from './imagine-models.ts'
import { jsonObjectOf } from './model-json.ts'
import { finite, isPlainObject, trimmedText } from './guards.ts'

/** One kind of thing in the photo and how many of it the model saw. */
export interface SegmentConcept {
  /** English noun phrase, as SAM 3 is asked for it. */
  readonly name: string
  /** Instances seen, 1-20. */
  readonly count: number
}

/** A piece of readable text and where it is, in fractions of the photo. */
export interface SegmentText {
  readonly text: string
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

/** What the model listed in one photo. */
export interface SegmentSight {
  readonly concepts: readonly SegmentConcept[]
  readonly texts: readonly SegmentText[]
}

/*
 * The default model took 157 s on one photo without a reasoning level, and
 * 150 s with "low" in a full run (2026-11-15); the studio-wide
 * SIGHT_TIMEOUT_MS (90 s) would leave it unanswered.
 */
export const SEGMENT_LOOK_TIMEOUT_MS = 300_000

/** More concepts than this is the model listing pixels, not things. */
export const MAX_CONCEPTS = 40
/** Readable texts kept per photo. */
export const MAX_TEXTS = 30
/** Ceiling on one concept's count (SAM 3 is asked for count + 2). */
export const MAX_COUNT = 20
/** Longest concept name and text kept. */
const MAX_NAME = 60
const MAX_TEXT = 80

/** The question asked of the photo, answered in JSON. */
export const SEGMENT_CONCEPTS_INSTRUCTION = `List every distinct thing visible in this image, so that a segmentation model (SAM 3) can cut each one out.

Rules:
- One entry per kind of thing, as a short English noun phrase SAM can find: "coffee cup", "silver chain necklace", "orange umbrella", "white clouds".
- Tell people apart when there are several: "man with sunglasses", "woman in red dress". Then list their clothes, accessories and jewellery separately ("black leather jacket", "ring", "earring").
- Include small things (rings, bracelets, buttons only if clearly visible), furniture, objects, plants, animals, vehicles, and the background (sky, clouds, wall, buildings, floor, table).
- count = how many separate instances you see (1 if one).
- Do not list body parts (face, hand, hair, leg) unless nothing else covers them.
- Also list every piece of readable text (signs, logos, labels, numbers) in "texts", with its box as [x1, y1, x2, y2] in 0-1000 coordinates relative to the image width and height.

Answer only with JSON:
{"objects": [{"name": "...", "count": 1}], "texts": [{"text": "...", "box": [x1, y1, x2, y2]}]}`

/**
 * A concept name SAM 3 can be given: the node splits its list on commas and
 * new lines and reads `name:N`, and the tokenizer drops parentheses.
 * @param value - what the model wrote.
 * @returns the cleaned phrase, or undefined when nothing is left.
 */
export function conceptName(value: unknown): string | undefined {
  const text = trimmedText(value)
  if (text === undefined) return undefined
  const clean = text.replaceAll(/[,:;()[\]{}\n\r\t"]+/g, ' ').replaceAll(/\s+/g, ' ').trim().toLowerCase()
  if (clean.length === 0 || clean.length > MAX_NAME) return undefined
  return clean
}

/** A count the model gave, as a whole number 1-MAX_COUNT. */
function countOf(value: unknown): number {
  const n = finite(value)
  if (n === undefined) return 1
  return Math.min(MAX_COUNT, Math.max(1, Math.round(n)))
}

/** A [x1, y1, x2, y2] box in 0-1000 as fractions, or undefined when it is not one. */
function boxOf(value: unknown): SegmentText['box'] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined
  const numbers = value.map(finite)
  if (numbers.some(n => n === undefined)) return undefined
  // In thousandths until the end: 0.5 - 0.4 is not 0.1 in floating point.
  const [x1, y1, x2, y2] = (numbers as number[]).map(n => Math.min(1000, Math.max(0, n)))
  const w = Math.abs(x2 - x1)
  const h = Math.abs(y2 - y1)
  if (w < 2 || h < 2) return undefined
  return { x: Math.min(x1, x2) / 1000, y: Math.min(y1, y2) / 1000, w: w / 1000, h: h / 1000 }
}

/**
 * Read the model's reply.
 * @param reply - the raw text, fences and preamble allowed.
 * @returns the concepts and texts, or undefined when the reply holds no list at all.
 */
export function parseSegmentSight(reply: string | undefined): SegmentSight | undefined {
  const object = jsonObjectOf(reply)
  if (object === undefined) return undefined
  const objects = Array.isArray(object.objects) ? object.objects : []
  const seen = new Set<string>()
  const concepts: SegmentConcept[] = []
  for (const entry of objects) {
    if (!isPlainObject(entry)) continue
    const name = conceptName(entry.name)
    if (name === undefined || seen.has(name)) continue
    seen.add(name)
    concepts.push({ name, count: countOf(entry.count) })
    if (concepts.length === MAX_CONCEPTS) break
  }
  const texts: SegmentText[] = []
  for (const entry of Array.isArray(object.texts) ? object.texts : []) {
    if (!isPlainObject(entry)) continue
    const text = trimmedText(entry.text)
    const box = boxOf(entry.box)
    if (text === undefined || text.length > MAX_TEXT || box === undefined) continue
    texts.push({ text, box })
    if (texts.length === MAX_TEXTS) break
  }
  if (concepts.length === 0 && texts.length === 0) return undefined
  return { concepts, texts }
}

/**
 * The `concepts` field of the `ImagineSegments` node: one `name:N` per line.
 * SAM 3 is allowed two more than the model counted, which tends to count low
 * (four people in the street read as two).
 * @param concepts - the parsed concepts.
 * @returns the text for the node.
 */
export function conceptLines(concepts: readonly SegmentConcept[]): string {
  return concepts.map(concept => `${concept.name}:${String(Math.min(MAX_COUNT, concept.count + 2))}`).join('\n')
}

/**
 * Ask the vision model what is in a photo.
 *
 * Never throws: no vision service, a model that does not answer in time or a
 * reply with no list all give undefined, and the caller says so.
 * @param ctx - the host, for the vision service.
 * @param path - the photo, absolute.
 * @param background - a look nobody waits for (a photo just made), in the capped lane.
 * @returns what the model listed, or undefined.
 */
export async function lookForSegments(ctx: ImagineHost, path: string, background = false): Promise<SegmentSight | undefined> {
  const eyes = eyesOf(ctx)
  if (eyes === undefined) return undefined
  const reply = await lookWith(eyes.vision, path, SEGMENT_CONCEPTS_INSTRUCTION, eyes.route, SEGMENT_LOOK_TIMEOUT_MS, { background })
  return parseSegmentSight(reply?.text)
}
