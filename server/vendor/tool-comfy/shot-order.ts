/**
 * The order the photos of a montage are cut in, decided by looking at them.
 *
 * The music-video form generates one photo per shot and the montage used them
 * in the order they came back — which is the order the queue happened to
 * finish them in. A video can then close on the singer's back, and two shots
 * in the same corner of the same room can sit at opposite ends of the video
 * while the cut between them jumps rooms twice. Nothing about the photos was
 * read before they were cut together.
 *
 * This module looks at each photo once and answers three things with what it
 * saw: which photo opens, which closes, and which neighbours which. Similar
 * shots — same setting, same light, same way of facing the camera — are put
 * next to each other, the video opens and closes on a face, and the director
 * is handed a line about each photo so the beat it writes fits the picture the
 * shot is actually generated from.
 * @module tool-comfy/shot-order
 */

import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { safeBasename } from './gallery.ts'
import { eyesOf } from './eyes.ts'
import { lookWith } from './imagine-models.ts'
import { jsonObjectOf } from './model-json.ts'
import { textField } from './guards.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'

/** Which way the subject faces the camera, from the model's fixed vocabulary. */
export type Facing = 'front' | 'three-quarter' | 'profile' | 'back' | 'unknown'

/** How much of the subject the photo holds. */
export type Framing = 'close' | 'medium' | 'full' | 'unknown'

/** What was seen in one photo of the montage. */
export interface ShotSight {
  /** The photo's basename in the gallery. */
  readonly name: string
  readonly facing: Facing
  readonly framing: Framing
  /** Where the subject is, in a few words. */
  readonly setting: string
  /** The light on them, in a few words. */
  readonly light: string
  /** What the body is doing, in a few words. */
  readonly pose: string
}

/*
 * The photos are read in parallel and the first shot of the montage waits for
 * all of them, so this is the most the GPU sits idle for the reading; a photo
 * the model does not answer is cut with nothing known about it. No deadline of
 * its own: the model's silence is the only bound (`server/src/llm.ts`).
 */

/** Longest reply read; past this the model is not answering the question. */
const MAX_REPLY_LENGTH = 2_000

/** The question every photo is asked, answered in a shape that can be sorted. */
const SHOT_SIGHT_INSTRUCTION = `Look at this photo and reply ONLY with a JSON object, with no other text:
{"facing": "front" | "three-quarter" | "profile" | "back", "framing": "close" | "medium" | "full", "setting": "<where it is, 3-8 words>", "light": "<the light: source, colour, time of day, 3-8 words>", "pose": "<what the body is doing, 3-10 words>"}

facing: which way the subject looks relative to the camera. "front" = face towards the camera; "three-quarter" = face turned three-quarter; "profile" = in profile; "back" = from behind, the face is not visible.
framing: "close" = face and shoulders only; "medium" = from the waist up; "full" = full body.
setting, light and pose in English, and only what is visible: no interpretations.`

/** What is known about a photo nothing could look at. */
function unseen(name: string): ShotSight {
  return { name, facing: 'unknown', framing: 'unknown', setting: '', light: '', pose: '' }
}

/** A field of the model's object as a trimmed string, or empty. */
function textOf(source: Record<string, unknown>, key: string): string {
  return textField(source, key) ?? ''
}

/** The model's facing word, or unknown for anything outside the vocabulary. */
function facingOf(value: string): Facing {
  const said = value.toLowerCase().replace(/[\s_]+/g, '-')
  if (said === 'front' || said === 'three-quarter' || said === 'profile' || said === 'back') return said
  if (said.includes('quarter')) return 'three-quarter'
  return 'unknown'
}

/** The model's framing word, or unknown for anything outside the vocabulary. */
function framingOf(value: string): Framing {
  const said = value.toLowerCase().trim()
  if (said === 'close' || said === 'medium' || said === 'full') return said
  if (said.startsWith('close')) return 'close'
  return 'unknown'
}

/**
 * Read one sight out of the model's reply.
 *
 * Tolerant the way the other readers are: a fenced block, a line of preamble
 * or a word outside the vocabulary each cost only the field they touch, never
 * the photo. Undefined only when no object came back at all.
 * @param text - the model's reply.
 * @param name - the photo it was asked about.
 * @returns the sight, or undefined when nothing usable came back.
 */
function parseShotSight(text: string | undefined, name: string): ShotSight | undefined {
  if (text === undefined || text.length > MAX_REPLY_LENGTH) return undefined
  const object = jsonObjectOf(text)
  if (object === undefined) return undefined
  return {
    name,
    facing: facingOf(textOf(object, 'facing')),
    framing: framingOf(textOf(object, 'framing')),
    setting: textOf(object, 'setting'),
    light: textOf(object, 'light'),
    pose: textOf(object, 'pose'),
  }
}

/**
 * Look at every photo of a montage.
 *
 * Never throws and never blocks the chain on a model that will not answer: a
 * missing vision service, a slow model or an unreadable reply leave that
 * photo unseen, and an unseen photo keeps the place it was given. The photos
 * are read side by side — nine of them one after the other would hold the
 * first shot for six minutes — within the studio-wide limit of `lookWith`,
 * whose timer starts when a look actually begins.
 * @param ctx - plugin context, for the vision service and Imagine's route.
 * @param outputDir - the validated media output directory.
 * @param photos - the photos' basenames, in the order they were given.
 * @param chosen - the model the chip showed when the video was asked for.
 * @returns one sight per photo, in the same order.
 */
export async function lookAtShots(
  ctx: ImagineHost,
  outputDir: string,
  photos: readonly string[],
  chosen?: ModelRoute,
): Promise<readonly ShotSight[]> {
  const eyes = eyesOf(ctx, chosen)
  if (eyes === undefined) return photos.map(unseen)
  // A photo that comes back in several shots (a take on one face cycles its
  // close-up) is looked at once.
  const looks = new Map<string, Promise<ShotSight>>()
  const look = (name: string): Promise<ShotSight> => {
    const known = looks.get(name)
    if (known !== undefined) return known
    const fresh = (async (): Promise<ShotSight> => {
      const safe = safeBasename(name)
      if (safe === undefined) return unseen(name)
      const reply = await lookWith(eyes.vision, join(outputDir, safe), SHOT_SIGHT_INSTRUCTION, eyes.route)
      return parseShotSight(reply?.text, name) ?? unseen(name)
    })()
    looks.set(name, fresh)
    return fresh
  }
  return Promise.all(photos.map(look))
}

/** The words of a short phrase, lowercased, for comparing two of them. */
function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(word => word.length > 2),
  )
}

/** How alike two short phrases are, 0 to 1; two empty phrases are alike. */
function overlap(a: string, b: string): number {
  const first = wordsOf(a)
  const second = wordsOf(b)
  if (first.size === 0 && second.size === 0) return 1
  if (first.size === 0 || second.size === 0) return 0
  let shared = 0
  for (const word of first) if (second.has(word)) shared += 1
  return shared / (first.size + second.size - shared)
}

/** Where each facing sits on the turn from the camera, for adjacency. */
const TURN: Readonly<Record<Facing, number>> = {
  'front': 0,
  'three-quarter': 1,
  'profile': 2,
  'back': 3,
  'unknown': 1,
}

/**
 * How well two photos sit next to each other, higher is closer.
 *
 * The room and the light weigh most: a cut inside the same corner of the same
 * room reads as coverage, a cut across rooms reads as a new scene. The way of
 * facing the camera counts by how far apart the two are on the turn, so a
 * front shot sits beside a three-quarter one before it sits beside a back one.
 * @param a - one photo.
 * @param b - the other.
 * @returns the closeness, on no particular scale.
 */
function closeness(a: ShotSight, b: ShotSight): number {
  const turn = Math.abs(TURN[a.facing] - TURN[b.facing])
  return overlap(a.setting, b.setting) * 3
    + overlap(a.light, b.light) * 2
    + overlap(a.pose, b.pose)
    + (1 - turn / 3)
    + (a.framing === b.framing ? 0.5 : 0)
}

/** How good a photo is to open the video on: a face, and the whole figure. */
function openerScore(sight: ShotSight): number {
  const facing = { 'front': 2, 'three-quarter': 1.5, 'profile': 0, 'back': -5, 'unknown': 0 }[sight.facing]
  const framing = { 'full': 1, 'medium': 1, 'close': 0, 'unknown': 0 }[sight.framing]
  return facing + framing
}

/** How good a photo is to close the video on: a face, close enough to read. */
function closerScore(sight: ShotSight): number {
  const facing = { 'front': 2, 'three-quarter': 1, 'profile': -1, 'back': -5, 'unknown': 0 }[sight.facing]
  const framing = { 'close': 1, 'medium': 1, 'full': 0, 'unknown': 0 }[sight.framing]
  return facing + framing
}

/**
 * The order to cut the photos in.
 *
 * Both ends are chosen first — the best opener, then the best closer among
 * the rest — and the path between them is greedy: from the opener, always the
 * closest photo not yet used. Back-facing shots land in the middle by
 * construction. Ties keep the order the photos came in, so a montage whose
 * photos nothing could look at is cut exactly as before.
 * @param sights - what was seen in each photo, in the order they were given.
 * @returns the same sights, in the order to cut them.
 */
export function orderShots(sights: readonly ShotSight[]): readonly ShotSight[] {
  if (sights.length < 3) return sights
  let opener = 0
  for (let index = 1; index < sights.length; index += 1) {
    const candidate = sights[index]
    const best = sights[opener]
    if (candidate !== undefined && best !== undefined && openerScore(candidate) > openerScore(best)) opener = index
  }
  // Last wins on a tie so an unseen set closes on its own last photo.
  let closer = -1
  for (let index = 0; index < sights.length; index += 1) {
    if (index === opener) continue
    const candidate = sights[index]
    const best = sights[closer]
    if (candidate !== undefined && (best === undefined || closerScore(candidate) >= closerScore(best))) closer = index
  }
  const path = [opener]
  const left = new Set(sights.map((_unused, index) => index))
  left.delete(opener)
  left.delete(closer)
  while (left.size > 0) {
    const from = sights[path[path.length - 1] ?? opener]
    let next = -1
    for (const index of left) {
      const candidate = sights[index]
      const best = sights[next]
      if (from === undefined || candidate === undefined) continue
      if (best === undefined || closeness(from, candidate) > closeness(from, best)) next = index
    }
    if (next < 0) break
    path.push(next)
    left.delete(next)
  }
  path.push(closer)
  return path.map(index => sights[index]).filter((sight): sight is ShotSight => sight !== undefined)
}

const FACING_TEXT: Readonly<Record<Facing, string>> = {
  'front': 'facing the camera',
  'three-quarter': 'three-quarter',
  'profile': 'in profile',
  'back': 'from behind',
  'unknown': '',
}

const FRAMING_TEXT: Readonly<Record<Framing, string>> = {
  'close': 'close-up',
  'medium': 'medium shot',
  'full': 'full body',
  'unknown': '',
}

/**
 * One line about a photo, for the director who has not seen it.
 * @param sight - what was seen.
 * @returns the line, or empty when nothing was seen.
 */
export function shotNote(sight: ShotSight): string {
  const parts = [
    [FACING_TEXT[sight.facing], FRAMING_TEXT[sight.framing]].filter(part => part.length > 0).join(', '),
    sight.setting,
    sight.light.length === 0 ? '' : `light: ${sight.light}`,
    sight.pose,
  ].filter(part => part.length > 0)
  return parts.join('; ')
}
