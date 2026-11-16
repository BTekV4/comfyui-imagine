/**
 * What the chat can actually see of the files in front of it.
 *
 * The written lane is a text call: the reading is told a file's name and kind
 * and nothing else. Asked "che colore e' lo sfondo di questa foto?" ("what
 * colour is this photo's background?") the model has no picture and answers
 * anyway — measured on 2026-09-06 against a solid blue field, it replied
 * "lo sfondo risulta di colore chiaro e neutro" ("the background is a light,
 * neutral colour"). An
 * invented description is worse than a refusal, so a still is looked at
 * here, and when nothing can look the instruction is told so in as many
 * words.
 *
 * Looking happens as early as it can, not when a line is written: a file is
 * queued for a look the moment a run produces it or an upload lands, and the
 * board's stills are queued when the studio opens a project. By the time a
 * line mentions "queste foto" most of them have already been seen, and what
 * was seen is filed beside the file's origin so that it outlives the
 * process. The line's own staged stills are the one place the chat waits:
 * they are what the sentence is about.
 *
 * A clip is read through one frame pulled out of it (2026-10-31): an upload
 * that is a video used to get no description at all, so its "Dettagli" card
 * and the Instagram caption had nothing but the file's name to work from.
 * @module tool-comfy/imagine-sight
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { lookWith, type VisionCapable } from './imagine-models.ts'
import { eyesOf } from './eyes.ts'
import { frameAt } from './media-tools.ts'
import { forgetSightNote, recallNote, rememberSight } from './imagine-notes.ts'
import { kindOf, safeBasename } from './gallery.ts'
import type { MediaFileRef } from '../../../shared/imagine-types.ts'
import { languageName } from '../../../shared/locale-names.ts'

/** What the studio saw in one still. */
export interface ImagineChatSight {
  /** The file's basename, as the instruction and the reading name it. */
  readonly name: string
  /** What the vision model said is in it. */
  readonly description: string
}

/** Whether the chat could look, and what it saw. */
export interface ImagineChatEyes {
  /** One entry per staged still that was read. */
  readonly sights: readonly ImagineChatSight[]
  /** A still is staged and nothing could look at it. */
  readonly blind: boolean
}

/** What a look may be told about the catalogue the file came from. */
export interface SightOptions {
  /** The interface language, for the description. */
  readonly language?: string
}

/**
 * How many background looks (see {@link lookSoon}) run side by side. The
 * vision lane of `lookWith` caps them as well; this keeps the backlog from
 * claiming files it is not yet looking at, which a chat line would then wait
 * on instead of looking itself.
 */
const BACKGROUND_PARALLEL = 2

/**
 * How long a failed look is not tried again in the background. Without it a
 * still the model times out on came back into the queue at every opening of
 * its project, and spent another 90 s slot failing.
 */
const FAILED_LOOK_TTL_MS = 30 * 60_000

/**
 * The language to describe an image in.
 *
 * It is the interface's, not the prompt's: someone using the studio in
 * English expects an English description even if they wrote in Italian.
 * The language name is written out in full, because the model reads it.
 * @param language - the interface language, when the caller knows it.
 * @returns the prompt for the reading model.
 */
function sightInstruction(language?: string): string {
  return SIGHT_INSTRUCTION.replace('in English', `in ${languageName(language)}`)
}

/** What the vision model is asked for: the picture, not an opinion of it. */
const SIGHT_INSTRUCTION = `Describe what is visible in this image, in English and in 2-3 sentences.
Name the subject, the setting, the dominant colours, the framing and any written text.
Describe only what you see: no interpretations, no judgements, no guesses about who the subject is.`

/** Said to the model when the picture is a frame pulled out of a clip. */
const CLIP_NOTE = '\nIt is a frame of a video: describe the scene you see, not the movement.'

/*
 * One description per file, kept for the life of the process and, through
 * the note, beyond it. Names are minted per upload and never reused, so a
 * cached description cannot go stale; the one thing that rewrites a file in
 * place is a crop, and `forgetSight` is what that calls.
 */
const seen = new Map<string, string>()

/** Looks in flight, so that a file queued twice is looked at once. */
const looking = new Map<string, Promise<string | undefined>>()

/** Files whose last look failed, and until when the background leaves them be. */
const failedUntil = new Map<string, number>()

/** One file waiting for a background look. */
interface Backlog {
  readonly ctx: ImagineHost
  readonly outputDir: string
  readonly name: string
  readonly options: SightOptions
}

/** The background looks not started yet, in order, and how many run. */
const backlog: Backlog[] = []
const backlogQueued = new Set<string>()
let backlogRunning = 0

/**
 * Drop one file's remembered description, for a file whose bytes changed.
 * @param name - the basename to forget; omitted forgets every one in memory.
 */
export async function forgetSight(name?: string): Promise<void> {
  if (name === undefined) {
    seen.clear()
    failedUntil.clear()
    return
  }
  seen.delete(name)
  failedUntil.delete(name)
  await forgetSightNote(name)
}

/**
 * Drop one file's remembered description from memory only, for a caller
 * that removes the note itself (a deleted file: its note is already gone, and
 * `forgetSight` would rewrite it a second time).
 * @param name - the basename to forget.
 */
export function forgetSeen(name: string): void {
  seen.delete(name)
  failedUntil.delete(name)
}

/**
 * Look at the stills staged in the chat, waiting for every one of them.
 *
 * Videos and songs are not read: this is the still pass, and a clip the model
 * cannot open would come back as an invented description, which is the fault
 * being fixed here.
 * @param ctx - the plugin context, for the vision service and Imagine's route.
 * @param outputDir - the validated media output directory.
 * @param staged - the files the composer is holding.
 * @param options - the catalogue the files may have come from.
 * @returns what was seen, and whether anything could look at all.
 */
export async function lookAtStaged(
  ctx: ImagineHost,
  outputDir: string,
  staged: readonly MediaFileRef[],
  options: SightOptions = {},
): Promise<ImagineChatEyes> {
  const stills = staged.filter(file => file.kind === 'image')
  if (stills.length === 0) return { sights: [], blind: false }
  const eyes = eyesOf(ctx)
  if (eyes === undefined) return { sights: [], blind: true }
  /*
   * There is no ceiling on how many a line may stage — the user's choice, on
   * 2026-09-09, was that a cap of two "non ha senso" — only on how many calls
   * are in flight at once, and that is the studio-wide vision lane of
   * `lookWith`: a second cap here was one more constant to keep equal to it.
   * A still that fails reads as unseen, as it did under the old cap, and
   * does not sink the others.
   */
  const descriptions = await Promise.all(stills.map(async file => await lookAt(ctx, outputDir, file.name, options).catch(() => undefined)))
  const sights: ImagineChatSight[] = []
  stills.forEach((file, index) => {
    const description = descriptions[index]
    if (description !== undefined) sights.push({ name: file.name, description })
  })
  // Blind is about the still the user is asking about, not about the service:
  // a vision model that is configured and answered nothing leaves the reading
  // exactly as blind as one that was never there.
  return { sights, blind: sights.length === 0 }
}

/**
 * What this process has already seen of one file, without reading anything.
 *
 * The chat reads every file's note once on its own; this is only the look
 * that landed in memory and whose note the caller did not find.
 * @param name - the basename to check.
 * @returns the description in memory, or undefined.
 */
export function sightInMemory(name: string): string | undefined {
  return seen.get(name)
}

/**
 * Queue stills for a look, and come back at once.
 *
 * This is how a file is seen before anyone asks about it: a run that has just
 * produced a photo, an upload that has just landed, a project that has just
 * been opened. Nothing waits on it; a line written while a look is still in
 * flight joins that look instead of starting another.
 * @param ctx - the plugin context.
 * @param outputDir - the validated media output directory.
 * @param names - basenames of stills to look at; other kinds are ignored here.
 * @param options - the catalogue the files may have come from.
 * @returns how many looks were started, for the caller's own bookkeeping.
 */
export function lookSoon(
  ctx: ImagineHost,
  outputDir: string,
  names: readonly string[],
  options: SightOptions = {},
): number {
  if (eyesOf(ctx) === undefined) return 0
  const now = Date.now()
  const wanted = [...new Set(names)].filter(name => !seen.has(name) && !looking.has(name)
    && !backlogQueued.has(name) && (failedUntil.get(name) ?? 0) <= now)
  if (wanted.length === 0) return 0
  for (const name of wanted) {
    backlog.push({ ctx, outputDir, name, options })
    backlogQueued.add(name)
  }
  drainBacklog()
  return wanted.length
}

/**
 * Start background looks while there is room for them.
 *
 * A file is claimed (put in `looking`) only when its look starts: a chat line
 * that stages a file still in the backlog looks at it at once, in the
 * foreground lane, and the backlog finds it seen when it gets there.
 */
function drainBacklog(): void {
  while (backlogRunning < BACKGROUND_PARALLEL) {
    const next = backlog.shift()
    if (next === undefined) return
    backlogQueued.delete(next.name)
    if (seen.has(next.name)) continue
    backlogRunning += 1
    void lookAt(next.ctx, next.outputDir, next.name, next.options, true)
      .catch(() => undefined)
      .finally(() => {
        backlogRunning -= 1
        drainBacklog()
      })
  }
}

/** Remember a failed look, dropping the expired ones so the map stays small. */
function rememberFailure(name: string): void {
  const now = Date.now()
  for (const [other, until] of failedUntil) {
    if (until <= now) failedUntil.delete(other)
  }
  failedUntil.set(name, now + FAILED_LOOK_TTL_MS)
}

/**
 * One file's description: remembered, on record, in flight, or looked up now.
 *
 * A failure is remembered for {@link FAILED_LOOK_TTL_MS}, which only the
 * background respects: a chat line about the file still tries again.
 * @param background - looked at for nobody in particular: the capped lane.
 * @returns the description, or undefined when nothing could be seen.
 */
async function lookAt(
  ctx: ImagineHost,
  outputDir: string,
  name: string,
  options: SightOptions,
  background = false,
): Promise<string | undefined> {
  const remembered = seen.get(name)
  if (remembered !== undefined) return remembered
  const pending = looking.get(name)
  if (pending !== undefined) return pending
  const task = (async (): Promise<string | undefined> => {
    const filed = (await recallNote(name))?.sight
    if (filed !== undefined) {
      seen.set(name, filed)
      return filed
    }
    const safe = safeBasename(name)
    const eyes = eyesOf(ctx)
    if (safe === undefined || eyes === undefined) return undefined
    // A song has no picture to look at: its description is its own audio.
    const kind = kindOf(safe)
    if (kind === 'audio') return undefined
    const asked = kind === 'video' ? sightInstruction(options.language) + CLIP_NOTE : sightInstruction(options.language)
    const path = join(outputDir, safe)
    const description = kind === 'video'
      ? await describeFrame(eyes.vision, path, eyes.route, asked, background)
      : await describe(eyes.vision, path, eyes.route, asked, background)
    if (description === undefined) {
      rememberFailure(name)
      return undefined
    }
    failedUntil.delete(name)
    seen.set(name, description)
    await rememberSight(name, description)
    return description
  })()
  looking.set(name, task)
  try {
    return await task
  } finally {
    looking.delete(name)
  }
}

/**
 * One look at a clip, through a frame pulled out of it.
 *
 * The whole video is not sent: the vision service would have to take a
 * multi-megabyte `video_url` (its own shrink path only covers stills), and a
 * frame at half a second is what a description of the scene needs anyway.
 * @param vision - the vision service.
 * @param video - absolute path of the clip.
 * @param route - the model Imagine looks with.
 * @param instruction - what to ask of the picture.
 * @param background - whether the look runs in the capped background lane.
 * @returns the description, or undefined when the frame or the look failed.
 */
async function describeFrame(
  vision: VisionCapable,
  video: string,
  route: { provider: string; model: string },
  instruction: string,
  background: boolean,
): Promise<string | undefined> {
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'imagine-sight-'))
    const frame = await frameAt(video, join(dir, 'frame.jpg'), { at: 0.5, maxSide: 768, quality: 3, timeoutMs: 20_000 })
    return await describe(vision, frame, route, instruction, background)
  } catch {
    return undefined
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * One look, bounded in time and never throwing.
 * @param auxiliary - the vision service.
 * @param path - absolute path of the still.
 * @param route - the model Imagine looks with.
 * @param instruction - what to ask of the picture.
 * @param background - whether the look runs in the capped background lane.
 * @returns the description, or undefined when the model did not answer.
 */
async function describe(
  auxiliary: VisionCapable,
  path: string,
  route: { provider: string; model: string },
  instruction: string,
  background: boolean,
): Promise<string | undefined> {
  const result = await lookWith(auxiliary, path, instruction, route, { background })
  const text = result?.text.trim()
  return text === undefined || text.length === 0 ? undefined : text
}
