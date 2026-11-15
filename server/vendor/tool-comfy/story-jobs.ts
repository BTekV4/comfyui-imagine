/**
 * Music videos and long takes: a story is queued as one job per shot, and
 * everything that outlives those jobs — the plan, the record on disk, the cut,
 * the resume after a restart, the lipsync check of a sung shot — lives here.
 *
 * `enqueueJob` comes from the runner, which in turn reads the plan and cuts
 * the video through this module: the two call each other only at run time.
 * @module tool-comfy/story-jobs
 */

import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { message, withLanguage } from '../../src/messages.ts'
import { runWorkflow } from './index.ts'
import type { LoadedWorkflow } from './index.ts'
import { AAC_192K, FASTSTART, ffmpegTo, h264Out, probeMedia, runProbe } from './media-tools.ts'
import { kindOf, probePixels, safeBasename } from './gallery.ts'
import { GUIDE_SECONDS } from './extend-video.ts'
import { CHAIN_SCENE_SECONDS } from './video-prompt.ts'
import { fadedStart, joinCuts, montageShots, renderedSeconds } from './montage.ts'
import { lookAtShots, orderShots, shotNote } from './shot-order.ts'
import {
  finalFileName, findStoryByFile, readAllStoryManifests, readStoryManifest, shotOfFileName, storyLabel,
  updateStoryManifest, writeStoryManifest,
  type StoryManifest, type StoryShotRecord,
} from './story-manifest.ts'
import { adoptJobFiles, adoptJobsInto, loadImagineStore, renameInProjects } from './imagine-store.ts'
import { resumePlan } from './story-resume.ts'
import type { ImagineWorkflows } from './workflow-fields.ts'
import {
  LIPSYNC_ARTICULATION, LIPSYNC_FACE_LOST, cameraMovements, laySongOver,
  storyLength, storyShots, writeStoryPlan, type StoryPlan, type StorySong,
} from './story.ts'
import type { MediaKind, ModelRoute } from '../../../shared/imagine-types.ts'
import { jobThatProduced, patchJob, putJob, renameJobFiles, type ImagineJob } from './job-queue.ts'
import type { ImagineJobRequest } from './job-request.ts'
import { enqueueJob } from './run-job.ts'

/** Whether a file is on disk: a stat, not a read. */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

/**
 * The photo shot `index` starts from and, unless the cuts are hard, the one it
 * arrives at: the photos come back round in order when there are more shots
 * than photos, and the last shot of the loop arrives at the photo the first
 * one left from.
 * @param photos - the photos in the order they are cut.
 * @param index - the shot's position.
 * @param hardCuts - true when no shot travels towards the next photo.
 * @returns the two photos, or nothing when there are none.
 */
function shotPhotos<T>(photos: readonly T[], index: number, hardCuts = false): { source?: T; lastSource?: T } {
  const source = photos.length === 0 ? undefined : photos[index % photos.length]
  if (source === undefined) return {}
  const next = photos.length > 1 && !hardCuts ? photos[(index + 1) % photos.length] : undefined
  return next === undefined ? { source } : { source, lastSource: next }
}

/**
 * The isolated vocal of each song a montage has sung, by track file name.
 *
 * Separating a track takes about a minute, and every shot of a montage sings a
 * slice of the same one: without this the eleven shots of a two-minute video
 * would separate it eleven times.
 */
export const vocalsBySong = new Map<string, string>()

/**
 * The vocal of a track, isolated, for the shot that has to sing it.
 *
 * H3 moves the mouth by listening to the audio it is given, and a full mix is
 * mostly drums, bass and synths. Measured on one segment on 2026-09-07, with
 * only the guide changed: the correlation between the audio the clip generated
 * and its own slice of the song was -0.271 with the mix — worse than an
 * unrelated slice, 0.217 — and +0.478 with the vocal alone. The full mix is
 * still what goes over the finished video; this is only what the model listens
 * to while it renders.
 * @param ctx - plugin context carrying the `comfy` client.
 * @param workflows - the graphs this deployment loaded.
 * @param outputDir - the validated media output directory.
 * @param song - the track's file name in the output directory.
 * @param hooks - the job's prompt-id callback and cancellation: a cancel while
 *   the voice is being separated stops ComfyUI too, and the bar follows it.
 * @returns the vocal's file name, or undefined when it could not be made.
 */
export async function vocalsOf(
  ctx: ImagineHost,
  workflows: ImagineWorkflows,
  outputDir: string,
  song: string,
  hooks: { readonly onPrompt: (promptId: string) => void; readonly signal: AbortSignal },
): Promise<string | undefined> {
  const separate = workflows.extractVocals
  if (separate === undefined) return undefined
  const cached = vocalsBySong.get(song)
  if (cached !== undefined) return cached
  const safe = safeBasename(song)
  if (safe === undefined) return undefined
  try {
    const bytes = await readFile(join(outputDir, safe))
    const { files } = await runWorkflow(
      ctx,
      separate,
      outputDir,
      {},
      {
        declared: join(outputDir, `vocals-${basename(safe, '.mp3')}.mp3`),
        inputAudio: { bytes, name: safe },
        onPrompt: hooks.onPrompt,
        signal: hooks.signal,
      },
    )
    const made = files.find(file => file.kind === 'audio')
    if (made === undefined) return undefined
    const name = basename(made.path)
    vocalsBySong.set(song, name)
    return name
  } catch {
    // A deployment without the separator, or a track it cannot read: the shot
    // sings the full mix, which is what it did before this existed.
    return undefined
  }
}

/**
 * The second of the track a shot sings from.
 *
 * @param shots - the seconds each shot was asked for, in order.
 * @param index - the shot's position.
 * @param songSeconds - the track's length, when it is known.
 * @param overlap - seconds every shot after the first shares with the one
 * before it: the pinned head of a chained shot, which the join removes.
 * @returns the offset in seconds, never past the end of the track.
 */
function songStartOf(shots: readonly number[], index: number, songSeconds?: number, overlap = 0): number {
  const before = shots.slice(0, index).reduce((sum, seconds) => sum + renderedSeconds(seconds), 0)
  const start = fadedStart(before, index, overlap)
  /*
   * A chained shot's start is where the previous shot's tail says it is: its
   * pinned head carries that second of the track, and a slice pulled earlier
   * to fit inside the song contradicts it — measured on the last shot of two
   * chains, both times the singing fell apart (0.10 against 0.99 on the shot
   * before). The slice is shortened at the song's end instead, when it runs.
   */
  if (overlap > 0) return start
  const length = renderedSeconds(shots[index] ?? 0)
  if (songSeconds === undefined || songSeconds <= length) return start
  return Math.min(start, Math.max(0, songSeconds - length))
}

/**
 * Seconds of new material each clip of a story adds, unless told otherwise.
 * The studio's one chain unit since 2026-11-15 ({@link CHAIN_SCENE_SECONDS}):
 * Openjutsu's plans and the Context Loop scenes render at most six seconds at
 * a time, and a story clip is cut to the same length so the two never drift.
 */
const STORY_CLIP_SECONDS = CHAIN_SCENE_SECONDS

/**
 * Longest chained shot unless the workflow says otherwise: the same chain
 * unit (it was 9, the 16 GB card's margin for a ten-second shot).
 */
const CHAINED_SHOT_SECONDS = CHAIN_SCENE_SECONDS

/** How long a story runs when neither the request nor a song says. */
const DEFAULT_STORY_SECONDS = 30

/**
 * The shot plan of each live story, by story id.
 *
 * Written once when the story is queued and read by every clip as its turn
 * comes: the planner is a text call that finishes in seconds, while the first
 * clip alone takes minutes of GPU, so nothing waits for it but the POST does
 * not either.
 */
const storyPlans = new Map<string, Promise<StoryPlan>>()

/** Drop a story's plan once its last shot has read it (or was cancelled). */
export function forgetStoryPlan(storyId: string): void {
  storyPlans.delete(storyId)
}

/**
 * The photos a montage's shot starts from and ends on, once its plan is in.
 *
 * A montage is queued with its photos in the order they were given, and the
 * plan — which looked at them — may cut them in another: the shot reads its
 * photo off the plan when its turn comes, so the reordering costs the POST
 * nothing and the first shot waits only for the reading. A montage cut to a
 * song keeps the order it was given, so its plan carries the photos unchanged.
 * @param job - a shot of a montage.
 * @returns the photo to start from and the one to arrive at, or undefined
 * when the plan kept the order the photos came in.
 */
export async function storyShotSources(job: ImagineJob): Promise<{ source: string; lastSource?: string } | undefined> {
  if (job.storyId === undefined || job.cut !== true || job.storyIndex === undefined) return undefined
  const plan = await storyPlans.get(job.storyId)
  const { source, lastSource } = shotPhotos(plan?.sources ?? [], job.storyIndex, job.hardCuts === true)
  if (source === undefined) return undefined
  return lastSource === undefined ? { source } : { source, lastSource }
}

/**
 * The plan of a montage: the photos looked at, ordered, and a beat per shot.
 *
 * The reading comes first because the director's beats are written for the
 * shots in their final order, each with a line about the photo it will be
 * generated from. An unseen set keeps the order it came in, and the director
 * is told nothing about the photos, as before.
 *
 * A montage cut to a song keeps the order its photos arrived in, and is not
 * reordered by what the reading saw. The caller writes one photo per lyric —
 * the console under the line about the console, the ball under the line about
 * the ball — so the sequence is the caller's editorial decision, and a set
 * ordered by visual likeness instead puts each picture under the wrong verse
 * (measured 2026-09-23: on a seventeen-photo music video every shot but the
 * first carried a photo the sequence did not intend, and the console sang the
 * pre-chorus). Sorting by likeness is what a montage without a track wants,
 * where no text dictates the order; with a track it discards the only thing
 * that knows what belongs where. The reading still runs: it writes each shot's
 * beat from the photo that shot will actually use.
 * @param ctx - plugin context.
 * @param outputDir - the validated media output directory.
 * @param intent - the user's line.
 * @param shots - the seconds of each shot, in order.
 * @param photos - the photos, in the order they were given.
 * @param opts - what the director is told beside the shots.
 * @returns the plan, with the photos in the order to cut them.
 */
async function planMontage(
  ctx: ImagineHost,
  outputDir: string,
  intent: string,
  shots: readonly number[],
  photos: readonly string[],
  opts: { song?: StorySong; model?: ModelRoute; continuous?: boolean },
): Promise<StoryPlan> {
  const sights = await lookAtShots(ctx, outputDir, photos, opts.model)
  const ordered = opts.song === undefined ? orderShots(sights) : sights
  const notes = shots.map((_unused, index) => {
    const seen = shotPhotos(ordered, index).source
    return seen === undefined ? '' : shotNote(seen)
  })
  const plan = await writeStoryPlan(ctx, intent, shots, {
    opening: false,
    cuts: true,
    shots: notes,
    camera: cameraMovements(shots.length),
    ...opts.continuous === true ? { continuous: true } : {},
    ...opts.model === undefined ? {} : { model: opts.model },
    ...opts.song === undefined ? {} : { song: opts.song },
  })
  return { ...plan, sources: ordered.map(sight => sight.name) }
}

/** The beat a clip of a story renders, when its plan is in. */
export async function storyBeat(job: ImagineJob): Promise<string | undefined> {
  if (job.storyId === undefined) return undefined
  const plan = await storyPlans.get(job.storyId)
  if (plan === undefined) return undefined
  return job.storyIndex === undefined ? plan.opening : plan.beats[job.storyIndex]
}

/**
 * What a story request carries.
 *
 * `sources` is one photo per shot, when the video is a montage rather than
 * one take: `source` is the still a single unbroken take grows out of; these
 * are the pictures a music video cuts between, and the studio queues one
 * clip for each of them.
 */
type StoryRequest = Pick<ImagineJobRequest,
  'prompt' | 'source' | 'sources' | 'song' | 'lyrics' | 'size' | 'aspectRatio' | 'seconds' | 'clipSeconds'
  | 'megapixels' | 'hardCuts' | 'model' | 'clipId'>

/** A story request's files, checked: the opening still or clip, the montage's photos, the track. */
interface StoryFiles {
  readonly intent: string
  readonly source: string | undefined
  readonly sourceKind: MediaKind | undefined
  readonly photos: readonly string[]
  /** A montage: one shot per photo, cut together. */
  readonly cuts: boolean
  readonly song: string | undefined
}

/** How long a story runs and how it is divided into shots. */
interface StoryTiming {
  readonly total: number
  readonly songSeconds: number | undefined
  /** Every shot after the first continues the previous one's latent. */
  readonly chained: boolean
  /** What each chained shot renders but does not deliver. */
  readonly overlap: number
  readonly shots: readonly number[]
}

/** The graphs a story renders on. */
interface StoryGraphs {
  readonly clips: LoadedWorkflow
  readonly continuations: LoadedWorkflow
  readonly opening: LoadedWorkflow | undefined
}

/**
 * Queue a long video: one clip per shot, each continuing the last.
 *
 * Nothing here is a new kind of run. A story is the chain the studio can
 * already be driven through by hand — generate a frame, animate it, extend it,
 * extend that — queued in one go with a plan behind it, so each clip is asked
 * for the beat that belongs at its place in the video rather than for the same
 * sentence every time. The clips stay ordinary jobs: each shows its own
 * progress, each can be cancelled, and cancelling one stops the rest.
 * @param ctx - plugin context carrying `comfy`, `auxiliary` and `llm`.
 * @param workflows - the loaded graphs; generate, video and extend are needed.
 * @param outputDir - the validated media output directory.
 * @param request - the studio request, with `seconds` as the TOTAL length.
 * @returns the first queued job of the chain.
 */
export async function startStory(
  ctx: ImagineHost,
  workflows: ImagineWorkflows,
  outputDir: string,
  request: StoryRequest,
): Promise<ImagineJob> {
  const files = storyFiles(request)
  const graphs = storyGraphs(workflows, files)
  const timing = await storyTiming(outputDir, request, files, graphs.clips)
  const storyId = randomUUID()
  const storySong = planStory(ctx, outputDir, request, files, timing, storyId)
  // One timestamp for the whole chain: the studio lists jobs newest first, and
  // a clip stamped a millisecond later would sit above the clip it follows.
  const now = Date.now()
  const queued = storyJobs(workflows, request, files, timing, graphs, storySong, storyId, now)
  for (const entry of queued) {
    putJob(entry.job.id, entry.job)
    enqueueJob(ctx, entry.workflow, workflows, outputDir, entry.job)
  }
  const first = queued[0]?.job
  if (first === undefined) throw new Error(message('story.empty'))
  /*
   * A music video is remembered past its jobs: what each shot was made of is
   * what a redo of that one shot needs, and the jobs are gone in half an hour.
   * The sources are the photos as given; the shot's own settles when it runs.
   */
  if (files.cuts && files.song !== undefined && graphs.clips.songAudio !== undefined) {
    await recordStory(request, files.song, files.photos, queued, storyId, now)
  }
  return first
}

/**
 * The files of a story request, checked before anything is planned.
 * @param request - the studio request.
 * @returns the files; throws with a sentence when one is not usable.
 */
function storyFiles(request: StoryRequest): StoryFiles {
  const intent = request.prompt.trim()
  if (intent.length === 0) throw new Error(message('job.promptRequired'))
  const source = request.source === undefined ? undefined : safeBasename(request.source)
  if (request.source !== undefined && source === undefined) throw new Error(message('job.sourceInvalid'))
  const sourceKind = source === undefined ? undefined : kindOf(source)
  if (source !== undefined && sourceKind !== 'image' && sourceKind !== 'video') {
    throw new Error(message('story.longFromImageOrClip'))
  }
  /*
   * The photos of a montage. Every one is checked the way `source` is — a name
   * the studio does not have is a hallucinated file, and the run would fail on
   * a path error halfway through the chain rather than here.
   */
  const photos = (request.sources ?? [])
    .map(name => safeBasename(name))
    .filter((name): name is string => name !== undefined && kindOf(name) === 'image')
  const song = request.song === undefined ? undefined : safeBasename(request.song)
  if (request.song !== undefined && (song === undefined || kindOf(song) !== 'audio')) {
    throw new Error(message('story.invalidSong'))
  }
  return { intent, source, sourceKind, photos, cuts: photos.length > 1, song }
}

/**
 * The graphs a story renders on.
 *
 * A video cut to a track uses the workflow that is given the track: its
 * clips are generated listening to their own seconds of the song, which is
 * what makes the singing match it. Without that workflow the shots are the
 * ordinary ones and the song is only laid over at the end.
 * @param workflows - the loaded graphs.
 * @param files - the story's checked files.
 * @returns the graphs; throws when the deployment lacks one the story needs.
 */
function storyGraphs(workflows: ImagineWorkflows, files: StoryFiles): StoryGraphs {
  const clips = files.song !== undefined && workflows.videoOnSong !== undefined
    ? workflows.videoOnSong
    : workflows.video
  const continuations = workflows.extendVideo
  const opening = workflows.generate
  if (clips === undefined || continuations === undefined) throw new Error(message('story.actionNotConfigured'))
  // A montage needs no opening frame: every shot starts from a photo already.
  if (files.source === undefined && !files.cuts && opening === undefined) throw new Error(message('story.actionNotConfigured'))
  return { clips, continuations, opening }
}

/**
 * How long the story runs and the seconds of each of its shots.
 * @param outputDir - the validated media output directory.
 * @param request - the studio request.
 * @param files - the story's checked files.
 * @param clips - the graph the shots render on.
 * @returns the timing of the chain.
 */
async function storyTiming(
  outputDir: string,
  request: StoryRequest,
  files: StoryFiles,
  clips: LoadedWorkflow,
): Promise<StoryTiming> {
  const { song, cuts, photos } = files
  const songProbe = song === undefined ? undefined : await probeMedia(join(outputDir, song))
  // A montage with no length asked for lasts as long as its photos: five
  // seconds a shot, which is what one clip is worth. A track ffprobe could
  // not read comes back as zero seconds, and that is no length to plan on.
  const songSeconds = songProbe !== undefined && songProbe.duration > 0 ? songProbe.duration : undefined
  const total = storyLength(request.seconds, songSeconds, cuts ? photos.length * 5 : DEFAULT_STORY_SECONDS)
  /*
   * A montage has as many shots as it has photos: the count is the user's,
   * not the clip length's. One take keeps deciding its own.
   */
  /*
   * A montage cut to a song, on a workflow that can chain: every shot after
   * the first is sampled with the previous shot's tail pinned at its head, so
   * the video is one continuous take through the photos rather than a stack
   * of clips. Each such shot delivers GUIDE_SECONDS less than it renders, and
   * both the shot count and the song offsets account for it.
   */
  const chained = cuts && song !== undefined && clips.chain !== undefined && request.hardCuts !== true
  const overlap = chained ? GUIDE_SECONDS : 0
  /*
   * A chained shot carries the previous shot's context on top of its own
   * frames: at ten seconds it peaked at 15.6-15.8 GB of the card's 16.3 and
   * failed whenever anything else was resident (measured, twice in one day),
   * at nine at 14.9 GB with the same picture. It is now the studio's six
   * ({@link CHAINED_SHOT_SECONDS}); the deployment can raise it back —
   * `chainShotSeconds` — knowing the odds.
   */
  const longest = chained
    ? Math.min(request.clipSeconds ?? STORY_CLIP_SECONDS, clips.chainShotSeconds ?? CHAINED_SHOT_SECONDS)
    : request.clipSeconds ?? STORY_CLIP_SECONDS
  const shots = cuts
    ? montageShots(total, photos.length, longest, overlap)
    : storyShots(total, request.clipSeconds ?? STORY_CLIP_SECONDS)
  return { total, songSeconds, chained, overlap, shots }
}

/**
 * Start writing the story's plan, which the shots read when their turn comes.
 * @returns the song as the director is told about it, when the story has one.
 */
function planStory(
  ctx: ImagineHost,
  outputDir: string,
  request: StoryRequest,
  files: StoryFiles,
  timing: StoryTiming,
  storyId: string,
): StorySong | undefined {
  const { intent, song, source, cuts, photos } = files
  const lyrics = song === undefined ? undefined : jobThatProduced(song)?.lyrics
  const storySong: StorySong | undefined = song === undefined
    ? undefined
    : {
      seconds: timing.songSeconds ?? timing.total,
      ...lyrics === undefined || lyrics.trim().length === 0 ? {} : { lyrics: lyrics.trim() },
    }
  /*
   * Lyrics with no track to lay over mean the clips sing them: the video model
   * writes its own audio, so a music video does not have to be a music job
   * plus a mix. A song wins over them — the words are already in that file,
   * and a character singing over it would be a second voice.
   */
  const sungLyrics = song === undefined ? request.lyrics?.trim() : undefined
  storyPlans.set(storyId, cuts
    ? planMontage(ctx, outputDir, intent, timing.shots, photos, {
      ...timing.chained ? { continuous: true } : {},
      ...request.model === undefined ? {} : { model: request.model },
      ...storySong === undefined ? {} : { song: storySong },
    })
    : writeStoryPlan(ctx, intent, timing.shots, {
      opening: source === undefined,
      ...request.model === undefined ? {} : { model: request.model },
      ...storySong === undefined ? {} : { song: storySong },
      ...sungLyrics === undefined || sungLyrics.length === 0 ? {} : { sung: { lyrics: sungLyrics } },
    }))
  return storySong
}

/** One job of a story's chain and the graph it renders on. */
interface QueuedShot {
  readonly job: ImagineJob
  readonly workflow: LoadedWorkflow
}

/**
 * The jobs of the chain, in the order they run: the opening frame when the
 * story needs one, then one job per shot.
 * @returns the jobs, not yet in the map.
 */
function storyJobs(
  workflows: ImagineWorkflows,
  request: StoryRequest,
  files: StoryFiles,
  timing: StoryTiming,
  graphs: StoryGraphs,
  storySong: StorySong | undefined,
  storyId: string,
  now: number,
): QueuedShot[] {
  const { intent, source, sourceKind, photos, cuts, song } = files
  const { shots, chained, overlap } = timing
  const queued: QueuedShot[] = []
  let previous: string | undefined
  if (source === undefined && !cuts && graphs.opening !== undefined) {
    const id = randomUUID()
    queued.push({
      workflow: graphs.opening,
      job: {
        id,
        action: 'generate',
        prompt: intent,
        status: 'queued',
        createdAt: now,
        storyId,
        storyCount: shots.length,
        ...request.size === undefined ? {} : { size: request.size },
        ...request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio },
        ...request.clipId === undefined ? {} : { clipId: request.clipId },
      },
    })
    previous = id
  }
  shots.forEach((seconds, index) => {
    const id = randomUUID()
    // Every shot of a montage is generated from its own photo, so none of them
    // is a continuation however far into the video it sits.
    const continues = !cuts && (index > 0 || sourceKind === 'video')
    queued.push({
      workflow: continues ? graphs.continuations : graphs.clips,
      job: {
        id,
        action: continues ? 'extend' : 'video',
        prompt: intent,
        status: 'queued',
        createdAt: now,
        seconds,
        storyId,
        storyIndex: index,
        storyCount: shots.length,
        /*
         * Shot n travels from photo n to photo n+1, so the video moves through
         * the pictures instead of cutting between them: the frame it ends on
         * is the frame the next shot opens with. More shots than photos when
         * the video is longer than the pictures can fill at one shot each,
         * and then they come back round in order — the last shot of the loop
         * arrives at the photo the first one left from.
         *
         * A montage asked for hard cuts names no arrival photo: the shot has
         * only its own, so the model has nothing to travel towards and the
         * clip stays in the scene its photo shows. That is what a set of
         * different scenes needs — with an arrival photo each clip changes
         * costume and place inside itself.
         */
        ...cuts
          ? {
            cut: true,
            ...request.hardCuts === true ? { hardCuts: true } : {},
            ...shotPhotos(photos, index, request.hardCuts === true),
          }
          : {},
        ...index === 0 && source !== undefined && !cuts
          ? { source }
          : previous === undefined ? {} : { follows: previous },
        ...request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio },
        ...request.megapixels === undefined ? {} : { megapixels: request.megapixels },
        ...index === shots.length - 1 && song !== undefined ? { song } : {},
        /*
         * Every shot sings its own seconds of the track, on the video's own
         * timeline: shot three starts where shots one and two ended.
         *
         * Measured with what the sampler produces, not what it was asked for:
         * H3 renders on a frame grid, so a ten-second shot is 10.125 seconds
         * long. Adding ten each time put every shot an eighth of a second
         * ahead of its slice, 1.4 seconds by the eleventh — the singing
         * visibly behind the track. And the last slice is pulled back inside
         * the song: asked for audio past the end, the model invents the tail
         * and the mouth follows the invention.
         */
        ...song !== undefined && workflows.videoOnSong !== undefined
          ? { sings: song, songStart: songStartOf(shots, index, storySong?.seconds, overlap) }
          : {},
        ...chained ? { chain: { folder: `h3_context/${storyId}`, index } } : {},
        ...request.clipId === undefined ? {} : { clipId: request.clipId },
      },
    })
    previous = id
  })
  return queued
}

/**
 * Write the record of a music video, and fold the director's plan into it once
 * the plan is in.
 */
async function recordStory(
  request: StoryRequest,
  song: string,
  photos: readonly string[],
  queued: readonly QueuedShot[],
  storyId: string,
  now: number,
): Promise<void> {
  await writeStoryManifest({
    storyId,
    label: storyLabel(storyId),
    createdAt: now,
    ...request.clipId === undefined ? {} : { clipId: request.clipId },
    song,
    sources: photos,
    ...request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio },
    ...request.megapixels === undefined ? {} : { megapixels: request.megapixels },
    ...request.model === undefined ? {} : { model: request.model },
    shots: queued
      .filter(entry => entry.job.storyIndex !== undefined)
      .map(entry => ({
        index: entry.job.storyIndex ?? 0,
        seconds: entry.job.seconds ?? 0,
        ...entry.job.songStart === undefined ? {} : { songStart: entry.job.songStart },
        ...entry.job.source === undefined ? {} : { source: entry.job.source },
        ...entry.job.chain === undefined ? {} : { chain: entry.job.chain },
      })),
    finals: [],
  }).catch(() => undefined)
  /*
   * Fold the director's plan into the record once it is written: the beat of
   * every shot and the photo order the vision pass chose. The plan lives in
   * memory only, so without this a restart mid-video would resume the shots
   * that had not run yet with a generic line and the photos in the order
   * they came in, not the order the director cut them.
   */
  void storyPlans.get(storyId)?.then(async (plan) => {
    await updateStoryManifest(storyId, current => ({
      ...current,
      shots: current.shots.map((shot) => {
        const source = shotPhotos(plan.sources ?? [], shot.index).source
        const beat = plan.beats[shot.index]
        return {
          ...shot,
          ...source === undefined ? {} : { source },
          ...beat === undefined || shot.prompt !== undefined ? {} : { prompt: beat },
        }
      }),
    })).catch(() => undefined)
  }).catch(() => undefined)
}

/**
 * The job that renders one shot of a recorded story again, or for the first time.
 * @param manifest - the story's record.
 * @param record - the shot.
 * @param opts - the beat to use, the version its file carries, whether the
 *   video is cut again when it lands, the job it waits for, and the caller's
 *   model.
 * @returns a queued job, not yet in the map.
 */
function shotJob(
  manifest: StoryManifest,
  record: StoryShotRecord,
  opts: { prompt: string; version: number; rebuild: boolean; follows?: string; model?: ModelRoute },
): ImagineJob {
  return {
    id: randomUUID(),
    action: 'video',
    prompt: opts.prompt,
    status: 'queued',
    createdAt: Date.now(),
    seconds: record.seconds,
    ...record.source === undefined ? {} : { source: record.source },
    cut: true,
    storyId: manifest.storyId,
    storyIndex: record.index,
    storyCount: manifest.shots.length,
    ...manifest.clipId === undefined ? {} : { clipId: manifest.clipId },
    ...manifest.aspectRatio === undefined ? {} : { aspectRatio: manifest.aspectRatio },
    ...manifest.megapixels === undefined ? {} : { megapixels: manifest.megapixels },
    ...manifest.song === undefined ? {} : { sings: manifest.song, songStart: record.songStart ?? 0 },
    ...record.chain === undefined ? {} : { chain: record.chain },
    ...opts.follows === undefined ? {} : { follows: opts.follows },
    ...opts.model === undefined ? {} : { model: opts.model },
    redo: { storyId: manifest.storyId, index: record.index, version: opts.version, rebuild: opts.rebuild },
  }
}

/**
 * Render one shot of a finished music video again and cut the video anew.
 *
 * The shot is named by its file — `videoclip-<label>-03of10.mp4` — and
 * everything else comes from the story's record: the photo, the beat, the
 * seconds of the song, the latent slot it continues. A prompt names what
 * should change in the shot; none keeps the beat the director wrote.
 * @param ctx - plugin context.
 * @param workflows - the loaded workflows.
 * @param outputDir - the validated media output directory.
 * @param request - the shot file as `source`, the change as `prompt`.
 * @returns the queued job.
 */
export async function startRedo(
  ctx: ImagineHost,
  workflows: ImagineWorkflows,
  outputDir: string,
  request: { prompt: string; source?: string; model?: ModelRoute },
): Promise<ImagineJob> {
  const source = request.source === undefined ? undefined : safeBasename(request.source)
  const shot = source === undefined ? undefined : shotOfFileName(source)
  if (source === undefined || shot === undefined) throw new Error(message('story.whichClip'))
  const manifest = await findStoryByFile(source)
  const record = manifest?.shots.find(entry => entry.index === shot.index)
  if (manifest === undefined || record === undefined) throw new Error(message('story.montageMissing', { source }))
  const workflow = workflows.videoOnSong
  if (workflow === undefined) throw new Error(message('story.actionNotConfigured'))
  if (record.source === undefined) throw new Error(message('story.unknownSourcePhoto', { number: shot.index + 1 }))
  const beat = request.prompt.trim()
  const job = shotJob(manifest, record, {
    prompt: beat.length > 0 ? beat : (record.prompt ?? `videoclip ${manifest.label}`),
    version: manifest.finals.length + 1,
    rebuild: true,
    ...request.model === undefined ? {} : { model: request.model },
  })
  putJob(job.id, job)
  enqueueJob(ctx, workflow, workflows, outputDir, job)
  return job
}

/**
 * Pick a stopped music video up where it stopped.
 *
 * The shots on disk stay as they are; the shots the song no longer reaches
 * are dropped from the record — and the rest renumbered, on disk and in every
 * project — and the shots still missing are rendered in order, each
 * continuing the latent the shot before it saved. The video is cut together
 * once, after the last of them; with nothing left to render it is cut right
 * away, as a job of its own so the board sees it land.
 * @param ctx - plugin context.
 * @param workflows - the loaded workflows.
 * @param outputDir - the validated media output directory.
 * @param request - any shot or cut of the story as `source`.
 * @returns the first queued job, or the job cutting the video.
 */
export async function startResume(
  ctx: ImagineHost,
  workflows: ImagineWorkflows,
  outputDir: string,
  request: { source?: string; model?: ModelRoute },
): Promise<ImagineJob> {
  const source = request.source === undefined ? undefined : safeBasename(request.source)
  const found = source === undefined ? undefined : await findStoryByFile(source)
  if (source === undefined || found === undefined) throw new Error(message('story.whichVideo'))
  const job = await resumeStory(ctx, workflows, outputDir, found, {
    ...request.model === undefined ? {} : { model: request.model },
  })
  if (job === undefined) throw new Error(message('story.alreadyComplete'))
  return job
}

/**
 * Carry one story to its finished cut from whatever is on disk.
 *
 * The one place resume happens: the chat action and the boot sweep both call
 * it. The shots on disk stay; the shots the song no longer reaches are dropped
 * — renumbered on disk, in projects and in the record — and the missing ones
 * are rendered in order, each continuing the latent the shot before it saved.
 * The video is cut once, after the last of them; with nothing left to render
 * the cut is queued right away, as a job so the board sees it land.
 * @param ctx - plugin context.
 * @param workflows - the loaded workflows; videoOnSong is required.
 * @param outputDir - the validated media output directory.
 * @param found - the story's record.
 * @param opts - the caller's model.
 * @returns the first queued job, the job cutting the video, or undefined when
 * the story was already finished (its last shots present and the cut on disk).
 */
async function resumeStory(
  ctx: ImagineHost,
  workflows: ImagineWorkflows,
  outputDir: string,
  found: StoryManifest,
  opts: { model?: ModelRoute } = {},
): Promise<ImagineJob | undefined> {
  const workflow = workflows.videoOnSong
  if (workflow === undefined) throw new Error(message('story.actionNotConfigured'))
  const files = found.shots.flatMap(shot => shot.file === undefined ? [] : [shot.file])
  const onDisk = await Promise.all(files.map(async file => exists(join(outputDir, file))))
  const present = new Set(files.filter((_, index) => onDisk[index] === true))
  const track = found.song === undefined ? undefined : await probeMedia(join(outputDir, found.song)).catch(() => undefined)
  const plan = resumePlan(found, present, track === undefined || track.duration <= 0 ? undefined : track.duration)
  if (plan.shots.length === 0) throw new Error(message('story.noShots'))
  // Already whole: every shot present and the final cut on disk. The boot
  // sweep reaches finished stories too, and must leave them alone.
  if (plan.pending.length === 0 && found.finals.length > 0
    && await exists(join(outputDir, found.finals[0] ?? ''))) return undefined
  if (Object.keys(plan.renames).length > 0) {
    for (const [from, to] of Object.entries(plan.renames)) await rename(join(outputDir, from), join(outputDir, to)).catch(() => undefined)
    await renameInProjects(plan.renames)
    renameJobFiles(plan.renames)
  }
  const manifest = await updateStoryManifest(found.storyId, current => ({ ...current, shots: plan.shots }))
  if (manifest === undefined) throw new Error(message('story.namedMontageMissing', { name: found.label }))
  if (plan.pending.length === 0) {
    const cut = cutStoryJob(manifest, outputDir)
    await adoptStoryIntoProjects(manifest, [cut.id])
    return cut
  }
  const last = plan.pending[plan.pending.length - 1]
  let previous: { index: number; id: string } | undefined
  let first: ImagineJob | undefined
  const queuedIds: string[] = []
  for (const index of plan.pending) {
    const record = manifest.shots[index]
    if (record === undefined) continue
    // The beat the director wrote for the shot; failing that, the one written
    // for the same photo elsewhere in the story.
    const prompt = record.prompt
      ?? manifest.shots.find(other => other.prompt !== undefined && other.source === record.source)?.prompt
      ?? `videoclip ${manifest.label}`
    const job = shotJob(manifest, record, {
      prompt,
      version: record.file === undefined ? 1 : manifest.finals.length + 1,
      rebuild: index === last,
      ...previous?.index === index - 1 ? { follows: previous.id } : {},
      ...opts.model === undefined ? {} : { model: opts.model },
    })
    putJob(job.id, job)
    enqueueJob(ctx, workflow, workflows, outputDir, job)
    previous = { index, id: job.id }
    queuedIds.push(job.id)
    first ??= job
  }
  if (first === undefined) throw new Error(message('story.noShotsToRedo'))
  // Into the project that already shows this story, so the resumed shots and
  // the cut that the last of them writes land on the board, not only on disk.
  await adoptStoryIntoProjects(manifest, queuedIds)
  return first
}

/**
 * How long after it was started a stopped story is still picked up on boot.
 *
 * A restart loses the in-memory queue, so a music video that was mid-flight
 * has to be continued from its record. This is the window in which the boot
 * sweep does that on its own: long enough to cover an overnight interruption,
 * short enough that a months-old abandoned experiment is not suddenly rendered
 * by a routine restart. A finished story (its cut on disk) is never touched,
 * whatever its age.
 */
const RESUME_ON_BOOT_MS = 24 * 60 * 60 * 1000

/**
 * Continue every music video that a restart left unfinished.
 *
 * Called once at boot. A story with no finished cut, recently started, whose
 * song and photos are still on disk, is carried to completion the way the chat
 * action would — the user asked for exactly this: "when it gets stuck it must
 * resume from where it stopped". A story the user would rather abandon is
 * deleted, and a deleted story leaves no record here to resume.
 * @param ctx - plugin context.
 * @param workflows - the loaded workflows; without videoOnSong nothing resumes.
 * @param outputDir - the validated media output directory.
 * @param now - the clock, injectable for tests.
 * @returns the story ids a resume was started for.
 */
export async function resumeUnfinishedStories(
  ctx: ImagineHost,
  workflows: ImagineWorkflows,
  outputDir: string,
  now: number = Date.now(),
): Promise<string[]> {
  if (workflows.videoOnSong === undefined) return []
  const manifests = await readAllStoryManifests()
  const newestStart = manifests.reduce((latest, manifest) => Math.max(latest, manifest.createdAt), 0)
  // Only a song montage with shots on the clock, recently started and not
  // yet finished. finals is set when the cut is written, so a done story is
  // skipped before its files are even looked at.
  const eligible = manifests.filter(manifest => manifest.song !== undefined && manifest.shots.length > 0
    && manifest.finals.length === 0
    && manifest.createdAt > 0 && now - manifest.createdAt <= RESUME_ON_BOOT_MS)
  /*
   * Resume only the newest one. The studio makes one music video at a time and
   * the GPU is serial, so a restart interrupts at most the one most recently
   * started; older unfinished records are attempts the user abandoned rather
   * than videos left mid-render, and resuming them would be a render storm the
   * next restart repeats. The user reaches an abandoned one by name when they
   * do want it back.
   */
  eligible.sort((a, b) => b.createdAt - a.createdAt)
  const newest = eligible[0]
  if (newest?.song === undefined) return []
  // Its song has to be on disk; an older record would lose to it below anyway.
  if (!await exists(join(outputDir, newest.song))) return []
  /*
   * And only when nothing was started after it. A video the user launched
   * again — the same song, the photos chosen differently — is the one they
   * want; the unfinished one before it is the attempt they walked away from.
   * On 2026-09-10 the boot sweep brought back a fourteen-shot montage that
   * had been superseded four minutes after it started, twice, once at each
   * restart: an hour of GPU on a video nobody was waiting for, alongside the
   * one that was.
   */
  if (newest.createdAt < newestStart) return []
  try {
    const job = await resumeStory(ctx, workflows, outputDir, newest)
    return job === undefined ? [] : [newest.storyId]
  } catch {
    // Its photos are gone, or its plan cannot be rebuilt: not something to
    // fail the boot over.
    return []
  }
}

/**
 * Put a resumed story's new jobs into the projects that already hold it.
 *
 * A montage queued the first time is adopted into its project as it is made;
 * a resume makes fresh jobs the project never heard of, so without this their
 * finished shots and the new cut would land only on disk. The project is found
 * by the story it already shows: any board carrying one of this story's files.
 * @param manifest - the story being resumed.
 * @param jobIds - the ids of the jobs the resume just queued.
 */
async function adoptStoryIntoProjects(manifest: StoryManifest, jobIds: readonly string[]): Promise<void> {
  if (jobIds.length === 0) return
  const prefix = `videoclip-${manifest.label}-`
  const finalStem = `videoclip-${manifest.label}`
  const store = await loadImagineStore().catch(() => undefined)
  if (store === undefined) return
  const holds = (name: string): boolean =>
    name.startsWith(prefix) || name === `${finalStem}.mp4` || name.startsWith(`${finalStem}-v`)
  const targets = store.projects.filter(project => project.itemNames.some(holds)).map(project => project.id)
  if (targets.length > 0) await adoptJobsInto(targets, jobIds).catch(() => undefined)
}

/**
 * Cut a story's video together as a job, so the board sees the cut land the
 * way it sees a shot land.
 * @param manifest - the story, every shot on disk.
 * @param outputDir - the validated media output directory.
 * @returns the running job; it settles when the cut is written.
 */
function cutStoryJob(manifest: StoryManifest, outputDir: string): ImagineJob {
  const job: ImagineJob = {
    id: randomUUID(),
    action: 'video',
    prompt: `videoclip ${manifest.label}`,
    status: 'running',
    createdAt: Date.now(),
    startedAt: Date.now(),
    storyId: manifest.storyId,
    ...manifest.clipId === undefined ? {} : { clipId: manifest.clipId },
  }
  putJob(job.id, job)
  // The job's reason is stored in the base language, as `enqueueJob` does.
  void withLanguage(undefined, () => rebuildStory(manifest.storyId, outputDir)).then(
    async (final) => {
      patchJob(job.id, { status: 'done', updatedAt: Date.now(), files: [{ name: basename(final), kind: 'video' }] })
      await adoptJobFiles(job.id, [basename(final)]).catch(() => undefined)
    },
    (error: unknown) => {
      patchJob(job.id, { status: 'error', error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() })
    },
  )
  return job
}

/**
 * Take the first seconds off a clip.
 *
 * Used both for a clip rendered without its chain context (GUIDE_SECONDS) and
 * for the last clip of a cut that overshot the track.
 * @param path - the clip.
 * @param outputDir - where to write the trimmed copy.
 * @param seconds - how much of the head to drop.
 * @param prefix - the temp name's prefix, so a stray file names its caller.
 * @returns the trimmed copy's path; the caller renames it into place or deletes it.
 */
export async function dropHead(path: string, outputDir: string, seconds: number = GUIDE_SECONDS, prefix = 'headless'): Promise<string> {
  // Dot-named like the montage's joins, so the gallery skips it until the
  // caller renames it into place.
  const out = join(outputDir, `.${prefix}-${randomUUID()}.mp4`)
  return ffmpegTo(out, [
    '-y', '-ss', seconds.toFixed(4), '-i', path,
    ...h264Out(), ...AAC_192K,
    ...FASTSTART, out,
  ], 300_000)
}

/**
 * Put the last shot back on the words the cut plays over it.
 *
 * A cut is always a little longer than the track: every shot rounds up to a
 * whole frame (9 s renders as 226 frames, 9.4167 s), so the sum overshoots and
 * `songStartOf` pulls the last shot's slice back to fit inside the song. The
 * mouth then sings that many seconds before the words the cut plays at its
 * position, and the lipsync probe cannot see it because the probe measures at
 * the same pulled-back slice. Measured on AUTUNNO 26/09/2026: 1.553 s, with the
 * record's own score for that shot at 0.614 a lag 0.
 *
 * Dropping the overshoot off the head of the last clip puts the mouth back on
 * the words and ends the video exactly with the track. The trim only happens
 * when the arithmetic says the pull-back is what the overshoot consists of —
 * a chained story's last shot is not pulled back, and a mismatch leaves the
 * video as it is rather than cutting it wrong.
 * @param paths - the clip of every shot, in order.
 * @param shots - the record's shots, in the same order.
 * @param trackSeconds - the song's length.
 * @param outputDir - where the trimmed copy goes.
 * @returns the paths to join, and the temp file to delete afterwards.
 */
async function fitLastShot(
  paths: readonly string[],
  shots: readonly StoryShotRecord[],
  trackSeconds: number,
  outputDir: string,
): Promise<{ paths: readonly string[]; temp?: string }> {
  const last = shots[shots.length - 1]
  const lastPath = paths[paths.length - 1]
  if (last === undefined || lastPath === undefined || paths.length < 2 || last.songStart === undefined) {
    return { paths }
  }
  const lengths = await Promise.all(paths.map(async path => (await probeMedia(path)).duration))
  const before = lengths.slice(0, -1).reduce((sum, seconds) => sum + seconds, 0)
  const pulled = before - last.songStart
  if (pulled <= 0.05) return { paths }
  const total = before + (lengths[lengths.length - 1] ?? 0)
  if (Math.abs(total - trackSeconds - pulled) > 0.15) return { paths }
  const temp = await dropHead(lastPath, outputDir, pulled, 'surplus')
  return { paths: [...paths.slice(0, -1), temp], temp }
}

/** Everything the probe answered, for what the caller needs beyond the score. */
export interface LipsyncProbe {
  /** Correlation at zero lag between the mouth's aperture and the voice. */
  readonly corr0: number
  /** The aperture's best lag, in seconds: positive means a mouth running late. */
  readonly bestLag?: number
  /** The correlation at that lag. */
  readonly bestCorr?: number
  /**
   * Correlation at zero lag between the mouth's MOVEMENT and the voice.
   *
   * The number the eye reads. A mouth painted open and held there has no
   * position to correlate and no movement either; a mouth that articulates has
   * both. Measured on AUTUNNO 26/09/2026: shots whose aperture lag was 1.25 s
   * sat at ~0.0 on movement, and shots that sang in time at 0.30-0.39.
   */
  readonly movCorr0?: number
  /** The movement's best lag, in seconds. */
  readonly movLag?: number
  /** Fraction of frames in the top 30 % of the aperture range. */
  readonly plateau?: number
  /** Frames read, and how many of them had no face in them. */
  readonly frames?: number
  readonly noFace?: number
}

/**
 * The number a probe printed, and the fields beside it.
 *
 * The probe writes one JSON line last — warnings from its libraries may come
 * before it — carrying `corr0` plus, on the current probe, the mouth's
 * movement and how long it held still. A probe predating those fields answers
 * without them, and then only the score is known.
 * @param raw - the JSON line the probe printed last.
 * @returns the answer, or undefined when there is no usable line.
 */
function parseLipsyncProbeDetail(raw: Record<string, unknown> | undefined): LipsyncProbe | undefined {
  const corr0 = raw?.corr0
  if (raw === undefined || typeof corr0 !== 'number' || !Number.isFinite(corr0)) return undefined
  const rest: { -readonly [K in keyof Omit<LipsyncProbe, 'corr0'>]?: number } = {}
  for (const key of ['bestLag', 'bestCorr', 'movCorr0', 'movLag', 'plateau', 'frames', 'noFace'] as const) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) rest[key] = value
  }
  return { corr0, ...rest }
}

/**
 * How well a rendered shot's mouth followed the voice it sang.
 *
 * Runs the deployment's probe over the clip. A probe that is missing, fails
 * or answers nothing gives no score, and a shot with no score is accepted as
 * it is: the check is a guard on the video, not a reason to lose a shot.
 * @param probe - the executable configured under `videoOnSong.lipsync`.
 * @param clip - the rendered shot.
 * @param voice - the vocal track the shot was given.
 * @param offset - the second of the voice the delivered clip starts at.
 * @returns the probe's answer, or undefined.
 */
export async function lipsyncScore(probe: string, clip: string, voice: string, offset: number): Promise<LipsyncProbe | undefined> {
  return parseLipsyncProbeDetail(await runProbe('labiale', probe, [clip, voice, offset.toFixed(3)], 600_000))
}

/**
 * Whether rendering the shot again can plausibly put its mouth on the voice.
 *
 * A retry only helps a shot the score says is off the voice, and only when the
 * drawing is what failed. The position score alone cannot tell those apart: on
 * AUTUNNO (2026-09-26) two shots sat at 0.04 on position with an identical
 * 1.25 s lag on every take — an artefact of a mouth the model painted rather
 * than animated — while the takes the archive kept for those same two range
 * from 0.014 to 0.295 on the movement, so a second render really is a new roll.
 * A shot whose movement is already there is off in phase, not in drawing, and
 * the score for it is the one the probe gets wrong: another take buys nothing.
 *
 * Two cases buy nothing either: a probe that gave no score, where there is
 * nothing to retry towards, and a shot the probe could not see a face in for
 * most of its frames, where the score says more about the detector than the
 * mouth.
 * @param probe - what the probe answered for the take just rendered.
 * @param floor - the deployment's `lipsync.min`.
 * @returns true when another take is worth the card time.
 */
export function worthRetrying(probe: LipsyncProbe | undefined, floor: number): boolean {
  if (probe === undefined) return false
  if (probe.corr0 >= floor) return false
  const frames = probe.frames ?? 0
  if (frames > 0 && (probe.noFace ?? 0) / frames > LIPSYNC_FACE_LOST) return false
  if (probe.movCorr0 === undefined) return true
  return probe.movCorr0 < LIPSYNC_ARTICULATION
}

/**
 * Cut a story's video together again from the shots its record names.
 *
 * Every shot has to be on disk: a missing one is a video that cannot be
 * rebuilt, not one to rebuild without it.
 * @param storyId - the story.
 * @param outputDir - the validated media output directory.
 * @returns the absolute path of the new cut, with the song on it.
 */
export async function rebuildStory(storyId: string, outputDir: string): Promise<string> {
  const manifest = await readStoryManifest(storyId)
  if (manifest === undefined) throw new Error(message('story.unknownMontage'))
  const shots = [...manifest.shots].sort((a, b) => a.index - b.index)
  // Present or not is all that is asked of each clip: a stat, not a read of
  // every shot into memory.
  const paths = await Promise.all(shots.map(async (shot) => {
    if (shot.file === undefined) throw new Error(message('story.clipMissing', { number: shot.index + 1 }))
    const path = join(outputDir, shot.file)
    await stat(path).catch(() => { throw new Error(message('story.clipMissingFile', { number: shot.index + 1, file: shot.file ?? '' })) })
    return path
  }))
  const songPath = manifest.song === undefined ? undefined : join(outputDir, manifest.song)
  const track = songPath === undefined ? undefined : await probeMedia(songPath)
  const final = join(outputDir, finalFileName(manifest.label, manifest.finals.length + 1))
  const joined = await joinShots(paths, shots, track, outputDir)
  if (songPath === undefined || track === undefined) {
    await rename(joined, final)
  } else {
    const made = await probeMedia(joined)
    const scored = await laySongOver(joined, songPath, made.duration, track.duration, outputDir)
    await unlink(joined).catch(() => undefined)
    await rename(scored, final)
  }
  // The video came out whole: the next hole, if there ever is one, gets its
  // own two attempts rather than inheriting these.
  await updateStoryManifest(storyId, current => ({ ...current, finals: [basename(final), ...current.finals], repairs: 0 }))
  return final
}

/**
 * Join a montage's shots, in order, into one video without its song.
 *
 * The one place a montage is cut: a redo's rebuild and the last shot of a
 * first render both come here. Hard cuts, and that is the point: every shot
 * was rendered towards the next one's photo, so consecutive shots already
 * share the frame at the seam, and a dissolve would blend a frame with itself.
 * The last shot is put back on its words first (see {@link fitLastShot}).
 * @param paths - the clip of every shot, in order.
 * @param shots - the record's shots in the same order, when there is a record.
 * @param track - the song's probe, when the montage has one.
 * @param outputDir - where the joined file goes.
 * @returns the joined file; the caller renames it into place.
 */
export async function joinShots(
  paths: readonly string[],
  shots: readonly StoryShotRecord[] | undefined,
  track: { readonly duration: number } | undefined,
  outputDir: string,
): Promise<string> {
  const first = paths[0]
  if (first === undefined) throw new Error(message('story.emptyMontage'))
  const pixels = await probePixels(first, 'video')
  const canvas = 'width' in pixels ? pixels : { width: 720, height: 1280 }
  const fitted = shots === undefined || track === undefined
    ? { paths }
    : await fitLastShot(paths, shots, track.duration, outputDir)
  try {
    return await joinCuts(fitted.paths, canvas.width, canvas.height, outputDir)
  } finally {
    if (fitted.temp !== undefined) await unlink(fitted.temp).catch(() => undefined)
  }
}

/**
 * How many times a story may queue its own missing shots before it stops
 * trying. Two passes cover a server that went away and came back; a shot that
 * cannot render at all must not put the card in a loop.
 */
const MAX_STORY_REPAIRS = 2

/**
 * Close a hole in a montage rather than reporting one.
 *
 * The cut refuses to assemble a video with a shot missing, and until now that
 * was the end of it: the shots stayed on the board and the user was told to
 * put them together by hand. But the studio knows exactly which shots are
 * missing and how to render them — that is what `resume` does — so it does
 * that instead of asking. Measured on 2026-09-09: a wedged ComfyUI cost five
 * shots in the middle of an eighteen-shot music video, the four after them
 * rendered fine, and the cut failed on `manca la clip 10` with a healthy card
 * sitting idle.
 *
 * Bounded by {@link MAX_STORY_REPAIRS}, counted on the record so a restart
 * cannot reset it, and set back to zero by a cut that comes out whole.
 * @param ctx - plugin context.
 * @param workflows - the loaded workflows.
 * @param outputDir - the validated media output directory.
 * @param storyId - the story whose cut found a hole.
 * @param model - the route the failed cut was running under, kept for the
 * beats the resumed shots may have to be written.
 * @returns whether shots were queued; false leaves the user the old notice.
 */
export async function repairStory(
  ctx: ImagineHost,
  workflows: ImagineWorkflows,
  outputDir: string,
  storyId: string,
  model?: ModelRoute,
): Promise<boolean> {
  const manifest = await readStoryManifest(storyId).catch(() => undefined)
  if (manifest === undefined || (manifest.repairs ?? 0) >= MAX_STORY_REPAIRS) return false
  const bumped = await updateStoryManifest(storyId, current => ({ ...current, repairs: (current.repairs ?? 0) + 1 }))
    .catch(() => undefined)
  if (bumped === undefined) return false
  const job = await resumeStory(ctx, workflows, outputDir, bumped, model === undefined ? {} : { model })
    .catch(() => undefined)
  return job !== undefined
}

/** Whether a job renders the last shot of its story, the last reader of the plan. */
export function isLastOfStory(job: ImagineJob): job is ImagineJob & { readonly storyId: string } {
  return job.storyId !== undefined && job.storyIndex === (job.storyCount ?? 0) - 1
}
