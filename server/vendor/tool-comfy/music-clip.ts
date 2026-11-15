/**
 * The music video, as one decision instead of four sentences.
 *
 * Making one by hand is a sequence: generate the photos, write the song, cut a
 * shot per photo, join them. Every step needs the names the previous one
 * produced, so the studio's own chat had to be told four times, in order, with
 * the right file selected each time — and a montage takes half an hour, so a
 * mistake in step two is found in step four.
 *
 * This module runs that sequence for one form: a look off the lookbook, a
 * genre and a voice, and the words to sing. The stages are ordinary Imagine
 * jobs — the same queue, the same cancel, the same gallery — chained here
 * rather than in the browser, so closing the page does not strand a half-built
 * video the user then has to finish by hand.
 * @module tool-comfy/music-clip
 */

import { message } from '../../src/messages.ts'
import { randomUUID } from 'node:crypto'
import type { ImagineHost } from '../../src/host.ts'
import type { ImagineWorkflows } from './workflow-fields.ts'
import { getImagineJob, listImagineJobs, startImagineJob, whenJobsSettle } from './imagine-jobs.ts'
import { adoptJobsInto } from './imagine-store.ts'
import { MAX_SHOT_SECONDS } from './montage.ts'
import type { Singer } from './music-prompt.ts'
import type { MusicClipPlan, MusicClipRequest } from '../../../shared/imagine-types.ts'

/** How long a clip runs when there are no words to time it by. */
const DEFAULT_CLIP_SECONDS = 60

/**
 * Words a song gets through in a second of its whole length.
 *
 * The form does not ask how long the video is, because the words already say:
 * a sheet of forty words is not a two-minute song, and asking twice only lets
 * the two answers disagree.
 *
 * Measured against the song, not against singing: a track is intro, breaths
 * between lines, instrumental bars and an outro as well as sung words. At 1.6
 * a sheet of 89 words asked for 60 seconds and MiniMax cut the lyrics to fit —
 * the user got a song that stopped following the text. Roughly a word a
 * second leaves the room those parts need.
 */
const WORDS_PER_SECOND = 1.1

/** The longest video this form will plan, in seconds. */
const MAX_CLIP_SECONDS = 240

/** Give up on a stage that never finishes, so the chain cannot hang forever. */
const STAGE_TIMEOUT_MS = 45 * 60_000

/**
 * A video length within the form's bounds: two shots at least, and never past
 * {@link MAX_CLIP_SECONDS}.
 * @param seconds - the length asked or computed.
 * @returns the length the chain plans.
 */
function clampClipSeconds(seconds: number): number {
  return Math.max(MAX_SHOT_SECONDS * 2, Math.min(MAX_CLIP_SECONDS, seconds))
}

/**
 * How long the video runs, read off the words it has to sing.
 *
 * Rounded to whole shots so the montage divides evenly, and floored at two
 * shots: below that it is a clip, not a video.
 * @param lyrics - the words to sing; empty means an instrumental.
 * @returns the length in seconds.
 */
function clipSeconds(lyrics: string): number {
  const words = lyrics.trim().split(/\s+/).filter(word => word.length > 0).length
  if (words === 0) return DEFAULT_CLIP_SECONDS
  const sung = Math.ceil(words / WORDS_PER_SECOND / MAX_SHOT_SECONDS) * MAX_SHOT_SECONDS
  return clampClipSeconds(sung)
}

/**
 * How many photos a clip of this length needs.
 *
 * One shot per photo at the sampler's ceiling: fewer photos would repeat, and
 * more would make shots too short to read as shots.
 * @param seconds - the finished video's length.
 * @returns the number of photos to generate, at least two.
 */
function clipShots(seconds: number): number {
  const total = clampClipSeconds(Math.round(seconds))
  return Math.max(2, Math.ceil(total / MAX_SHOT_SECONDS))
}

/**
 * The line the music workflow is asked for, out of the form's two fields.
 *
 * The genre is the user's, unedited: the caption writer expands it into the
 * three sections MiniMax Music wants, and a sentence built here would only
 * give it a second opinion to reconcile. The voice is added because the form
 * asks for it separately and the words alone never say it.
 * @param genre - the genre and production the user wrote.
 * @param voice - which voice sings.
 * @returns the prompt for the music job.
 */
function songLine(genre: string, voice: Singer): string {
  const said = genre.trim()
  const singer = voice === 'male' ? 'male voice' : 'female voice'
  if (said.length === 0) return singer
  return `${said}, ${singer}`
}

/**
 * Wait for a set of jobs to finish, then hand back the files they produced.
 * @param ids - the jobs to wait for.
 * @param kind - which produced file to collect.
 * @returns the file names, in the order the jobs were given, skipping failures.
 */
async function harvest(ids: readonly string[], kind: 'image' | 'audio'): Promise<string[]> {
  // Woken by the job writes themselves, so the next stage starts the moment
  // this one lands.
  await whenJobsSettle(ids, STAGE_TIMEOUT_MS)
  const names: string[] = []
  for (const id of ids) {
    const produced = getImagineJob(id)?.files?.find(file => file.kind === kind)
    if (produced !== undefined) names.push(produced.name)
  }
  return names
}

/**
 * Build a music video from one form: photos, then a song, then the montage.
 *
 * Returns as soon as the first two stages are queued. The montage is started
 * by the chain itself once it knows the names, so the caller gets the jobs to
 * watch immediately rather than holding a request open for half an hour.
 * @param ctx - plugin context.
 * @param workflows - the graphs this deployment loaded.
 * @param outputDir - the validated media output directory.
 * @param request - the form.
 * @returns the jobs that were queued, and the shape of the video to come.
 */
export async function startMusicClip(
  ctx: ImagineHost,
  workflows: ImagineWorkflows,
  outputDir: string,
  request: MusicClipRequest,
): Promise<MusicClipPlan> {
  const look = request.look.trim()
  if (look.length === 0) throw new Error(message('music.lookRequired'))
  if (workflows.generate === undefined) throw new Error(message('music.imageWorkflowNotConfigured'))
  if (workflows.generateMusic === undefined) throw new Error(message('music.workflowNotConfigured'))
  /*
   * The request may still name a length — the API battery and the chat both
   * can — but the form does not: it sends the words and the length follows.
   */
  const seconds = request.seconds === undefined
    ? clipSeconds(request.lyrics)
    : clampClipSeconds(Math.round(request.seconds))
  const shots = clipShots(seconds)
  const clipId = randomUUID()
  const common = {
    clipId,
    ...request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio },
    ...request.size === undefined ? {} : { size: request.size },
    ...request.model === undefined ? {} : { model: request.model },
  }
  /*
   * One photo per shot, drawn by the plain text-to-image graph from the look.
   * Until 2026-11-04 they went through the lookbook's catalogue node, which is
   * a custom one, with a pose per shot; no client sends poses any more
   * (2026-11-15), so every shot is the look as written.
   */
  const photoIds: string[] = []
  for (let index = 0; index < shots; index++) {
    const job = await startImagineJob(ctx, workflows, outputDir, {
      action: 'generate',
      prompt: look,
      ...common,
    })
    photoIds.push(job.id)
  }
  const song = await startImagineJob(ctx, workflows, outputDir, {
    action: 'music',
    prompt: songLine(request.genre, request.voice),
    seconds,
    clipId,
    ...request.lyrics.trim().length === 0 ? {} : { lyrics: request.lyrics.trim() },
    ...request.model === undefined ? {} : { model: request.model },
    // The form's Voce field, carried to the caption rather than left to
    // survive a rewrite of the user's own sentence into English.
    singer: request.voice,
  })
  const owner = request.projectId
  // The adoption is the host's, and it must not fail the form: a store that
  // cannot be written leaves the studio to adopt the waves as it did before.
  const adopt = async (ids: readonly string[]): Promise<void> => {
    if (owner === undefined || ids.length === 0) return
    await adoptJobsInto([owner], ids).catch(() => undefined)
  }
  await adopt([...photoIds, song.id])
  /*
   * Detached on purpose: the montage cannot be queued until the photos and the
   * song have names, and that is twenty minutes away. Failures here are the
   * chain's own — the stages are already in the gallery with their own errors
   * — so nothing is thrown into a request nobody is holding.
   */
  void (async () => {
    const photos = await harvest(photoIds, 'image')
    const [track] = await harvest([song.id], 'audio')
    if (photos.length < 2 || track === undefined) return
    const first = await startImagineJob(ctx, workflows, outputDir, {
      action: 'story',
      prompt: `videoclip ${look}`,
      sources: photos,
      song: track,
      seconds,
      ...request.lyrics.trim().length === 0 ? {} : { lyrics: request.lyrics.trim() },
      ...common,
    }).catch(() => undefined)
    if (first?.storyId === undefined) return
    const storyId = first.storyId
    await adopt(listImagineJobs().filter(job => job.storyId === storyId).map(job => job.id))
  })()
  return { clipId, photos: photoIds, song: song.id, shots, seconds }
}
