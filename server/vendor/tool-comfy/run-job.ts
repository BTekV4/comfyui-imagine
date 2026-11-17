/**
 * The runner: one queued job taken through its graph. The GPU chain and its
 * deadline, the inputs read when the turn comes, the prompts written around
 * the user's line, the render with its retries; the scan, the object swap's
 * single prompt, the steps after the render and the stories have modules of
 * their own.
 * @module tool-comfy/run-job
 */

import { randomUUID } from 'node:crypto'
import { message, withLanguage } from '../../src/messages.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { renameWithRetry, unlinkWithRetry } from '../retry-fs/index.ts'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { ComfyError } from '../comfyui/index.ts'
import { declaredOutputPath, freeOutputPath, runWorkflow } from './index.ts'
import type { ComfyProducedFile, LoadedWorkflow } from './index.ts'
import { FPS, dropScratch, ffmpegTo, frameAt, layPlateAudio, probeMedia, type MediaProbe } from './media-tools.ts'
import { resolveInputImage, resolveInputVideo, type ResolvedInputVideo } from './input-image.ts'
import { kindOf, probePixels, safeBasename, upscaleLongFor, upscaleTargetFor } from './gallery.ts'
import { writeEditPrompt } from './edit-prompt.ts'
import { applyRealismToken, chainSceneSeconds, soundtrackOf, writeH3ChainPrompts, writeH3Prompt } from './video-prompt.ts'
import { GUIDE_SECONDS, h3Canvas, videoTail } from './extend-video.ts'
import { formatSize } from './snap-size.ts'
import { closestLabel, gapOf, ratioOf, VISIBLE_RATIO_GAP } from './media-aspect.ts'
import { MAX_SHOT_SECONDS, closeLoop, joinCuts, montageShots, renderedSeconds, silentCopy } from './montage.ts'
import { isSilent, loudnessOf } from './vocal-silence.ts'
import { shotFileName, storyLabel, updateStoryShot } from './story-manifest.ts'
import { writeMusicScore } from './music-prompt.ts'
import {
  REGENERATE_FADE_SECONDS, REGENERATE_WINDOW_FRAMES, regenerateDraft, regeneratePrompt, regenerateStarts,
} from './regenerate.ts'
import { writeObjectSwapTexts } from './object-swap-texts.ts'
import { recreateBrief } from './recreate-video.ts'
import { recallWrittenPrompt } from './written-prompts.ts'
import {
  DEFAULT_OBJECT_PLACEMENT, type ImagineAction, type ImagineRegion, type MediaKind,
} from '../../../shared/imagine-types.ts'
import type { ImagineWorkflows } from './workflow-fields.ts'
import { LIPSYNC_MIN, listeningPrompt, singingPrompt } from './story.ts'
import {
  endRunControl, getImagineJob, isSettled, jobThatProduced, patchJob, setJobNotice, setJobPromptId, endSetup, setSetupProgress, startRunControl, waitForSetupApproval,
  stopRun, takePaintedMask, type ImagineJob,
} from './job-queue.ts'
import { ACTION_RUNS, pixelCache, placementKeyframes, type PixelsOf } from './job-request.ts'
import { readRecreation, runScanFrame, type ScanRun } from './scan-jobs.ts'
import {
  loopsItsOwnWindows, nextSeed, renderRelay, type Assemble, type Render, type RenderOver,
} from './swap-windows.ts'
import { finishRun, type DeliveredShot } from './job-finish.ts'
import {
  dropHead, forgetStoryPlan, isLastOfStory, lipsyncScore, storyBeat, storyShotSources, vocalsBySong, vocalsOf,
  worthRetrying, type LipsyncProbe,
} from './story-jobs.ts'

/*
 * ComfyUI runs one prompt at a time. A batch that fires N jobs at once would
 * spend each job's timeout waiting in that queue, so the ones at the back fail
 * before they ever start. Chain the runs: a job stays `queued` until the
 * previous one settles, and its deadline starts when it really begins.
 */
let queue: Promise<void> = Promise.resolve()

/**
 * Hard ceiling per job, comfortably above the workflow timeout. Only a run
 * that hangs outside that timeout (an upload or a media fetch that never
 * settles) can reach it — without this the whole chain, and therefore every
 * user, would wait on it forever.
 *
 * Fifty minutes since 2026-10-15: the run timeout went to 45 for the upscale
 * of a minute-long background, which is one run for the whole clip.
 */
const JOB_DEADLINE_MS = 3_000_000

/**
 * The ceiling of a job whose graph plans and chains its own clips (Openjutsu's
 * character and object swaps): the whole clip is one run, and its own deadline
 * grows with the clip (`timeoutMs` in `readInputs`). This stays a safety net
 * above it, for a hang outside the run.
 */
const LONG_JOB_DEADLINE_MS = 12 * 3_600_000

/**
 * Whether the job's graph plans and chains its own clips, so the whole clip
 * is one long run: both character-swap graphs and the object-swap graphs
 * carry a loop start (`loopsItsOwnWindows`). The action test stays as a
 * safety net for a custom character-swap graph without one, which still
 * renders the whole clip in one prompt.
 * @param job - the job.
 * @param workflow - the graph it runs.
 * @returns true for a self-chaining run.
 */
function chainsItsOwnClips(job: ImagineJob, workflow: LoadedWorkflow): boolean {
  return job.action === 'swapPerson' || loopsItsOwnWindows(workflow)
}

/**
 * Put one job at the back of the GPU queue, with its own deadline.
 *
 * The deadline is armed when the job's turn comes, not when it is queued: a
 * clip that waits forty minutes behind the rest of a story has not itself
 * taken too long.
 * @param ctx - plugin context.
 * @param workflow - the graph this job runs.
 * @param workflows - every graph this deployment loaded.
 * @param outputDir - the validated media output directory.
 * @param job - the queued job.
 */
export function enqueueJob(
  ctx: ImagineHost,
  workflow: LoadedWorkflow,
  workflows: ImagineWorkflows,
  outputDir: string,
  job: ImagineJob,
): void {
  /*
   * The run writes its reasons in the base language, whoever queued it: a
   * promise callback inherits the language of the request that chained it,
   * so without this a job queued from an English page stored an English
   * reason, which `translateMessage` (`jobWithProgress`) cannot turn back for
   * an Italian reader. Stored in Italian, every reader gets their own.
   */
  queue = withLanguage(undefined, () => queue.then(async () => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = globalThis.setTimeout(() => {
        const current = getImagineJob(job.id)
        if (current !== undefined && !isSettled(job.id)) {
          patchJob(job.id, { status: 'error', error: message('job.timeout'), updatedAt: Date.now() })
          /*
           * Stop the run as a cancel does. Marking the job alone let the queue
           * move on while the old prompt kept ComfyUI busy, and the run then
           * finished as `done` over the error — a story's next shot had
           * already died on a parent in error (2026-10-20).
           */
          void stopRun(ctx, job.id, current.promptId)
        }
        resolve()
      }, chainsItsOwnClips(job, workflow)
        ? LONG_JOB_DEADLINE_MS
        : JOB_DEADLINE_MS)
    })
    try {
      // A rejection is not swallowed here: it reaches the catch below, which
      // writes it in the journal and marks the job.
      await Promise.race([runImagineJob(ctx, workflow, workflows, outputDir, job), deadline])
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer)
    }
  }).catch((error: unknown) => {
    /*
     * One job that throws outside its own guard must not freeze the queue for
     * good. The chain is a promise: a rejection skips every callback chained
     * after it, in silence. On 2026-10-31 that is exactly what happened — the
     * first job after a restart rejected, and the eight jobs queued afterwards
     * sat at `queued` with nothing running and not one line in the journal,
     * while ComfyUI was idle. The job that threw is marked, so its tile can be
     * retried instead of lying about being in the queue.
     */
    console.warn(`[imagine] job queue: job ${job.id} (${job.action}): ${error instanceof Error ? error.message : String(error)}`)
    const live = getImagineJob(job.id)
    if (live !== undefined && (live.status === 'queued' || live.status === 'running')) {
      patchJob(job.id, { status: 'error', error: message('job.queueStopped'), updatedAt: Date.now() })
    }
  }))
}

/**
 * What one run carries from step to step: the working copy of the job and
 * everything the passes before the render write for the render to read.
 */
interface RunState {
  /**
   * The run's working copy of the job. A clip of a story learns two things
   * only when its turn comes — the file it continues and the beat it renders —
   * and a recreation learns its opening frame: they are written here so the
   * rest of the run reads them the way any other run does. Whatever the
   * page should see is also patched onto the live job when it changes.
   */
  job: ImagineJob
  /** Service files written outside the gallery, deleted however the run ends. */
  readonly scratch: string[]
  /** The prompt a pass wrote for the sampler, filed under the clip it produced. */
  writtenPrompt?: string
  /** A chained clip's scene prompts, in order (the first is also `prompt`). */
  chainPrompts?: string[]
  /** The prompt that reaches the sampler. */
  prompt: string
  /** Only the vision pass sets this; a clip whose prompt was not written keeps the LoRA off. */
  realistic: boolean
  /** A chained shot rendered without its context: its head is trimmed by hand. */
  headless: boolean
  /** What the vision pass saw happen in the reference clip of a recreation. */
  recreateMotion?: string
  /** The tracker phrase and the reference document of an object swap. */
  subjectText?: string
  referenceText?: string
  /** The placement box of «add an object», as the graph's JSON. */
  placementText?: string
  /** A song's lyrics with their structure tags, and its length. */
  musicLyrics?: string
  musicSeconds: number
}

/** What the run reads, resolved when its turn comes. */
interface RunInputs {
  readonly sourceKind: MediaKind | undefined
  readonly sourceVideo: string | undefined
  readonly inputImage?: { readonly bytes: Uint8Array; readonly name: string }
  readonly inputVideo?: ResolvedInputVideo
  /** The second image slot: a clip's last frame, or a zone edit's mask. */
  readonly lastImage?: { readonly bytes: Uint8Array; readonly name: string }
  /** An edit's reference photo, for the graph's `refImageNodeId`. */
  readonly refImage?: { readonly bytes: Uint8Array; readonly name: string }
  /** The recreation's opening frame, which it animates. */
  readonly drawnFrame?: string
  /** A deadline for the render longer than ComfyUI's own, for a graph that loops its own clips. */
  readonly timeoutMs?: number
  /**
   * The clip a continuation extends: its length, its pixels (the seam fits the
   * continuation to them) and the canvas it renders on.
   */
  readonly extendSource?: {
    readonly duration: number
    readonly pixels?: { readonly width: number; readonly height: number }
    readonly size?: string
  }
  /** The continuation's source frame, for the vision pass. */
  readonly extendFrame?: string
  readonly resolutionMax?: number
  /**
   * The photo's width over height, when the job animates one.
   *
   * The canvas a video renders on is chosen from this: an H3 graph takes its
   * size from a `ResolutionSelector` and stretches whatever it is given.
   */
  readonly imageRatio?: number
  /** An object swap's plate length, measured once for the deadline and the texts pass. */
  readonly plateSeconds?: number
}

/** What the run hands the graph as its audio, and how the shot sings. */
interface RunAudio {
  readonly bytes?: Uint8Array
  readonly name?: string
  /** A sung shot's guide is on the run. */
  readonly sings: boolean
  /** Whether this shot's slice of the vocals has anything in it to sing. */
  readonly silentSlice: boolean
  /** The vocal the shot listened to, on disk, for the lipsync probe. */
  readonly voiceFile?: string
}

/**
 * The Context Loop plan of a chained clip: one scene per prompt, each with its
 * length. A plan with fewer prompts than scenes (no vision pass) repeats the
 * last one as a plain continuation.
 * @param prompts - the scene prompts, in order.
 * @param scenes - each scene's length in seconds.
 * @returns the plan as JSON.
 */
function chainPlanJson(prompts: readonly string[], scenes: readonly number[], carried = 0): string {
  return JSON.stringify({
    shots: scenes.map((seconds, index) => ({
      id: `scene_${String(index + 1)}`,
      prompt: prompts[index] ?? prompts.at(-1) ?? '',
      // A scene that continues another gives back the frames it carries over:
      // asked for that much more, it delivers its own length.
      duration_seconds: Math.round((seconds + carried) * 100) / 100,
    })),
  }, null, 2)
}

/** The written prompt, with the realism token when the vision pass judged it and the graph has one. */
function withRealism(prompt: string, realistic: boolean, workflow: LoadedWorkflow): string {
  return realistic && workflow.realism !== undefined ? applyRealismToken(prompt, workflow.realism.token) : prompt
}

/**
 * The segments an animated background is rendered in.
 *
 * The model's own ceiling is ten seconds, so a minute is not one render: it is
 * a chain of segments dissolved into one another. {@link montageShots} sizes
 * the chain on what the sampler really produces — a ten-second shot is
 * 10.125 s — and every dissolve eats half a second of the finished file, so a
 * minute comes out 58.25 s. That is left as it is: the length is a rung on the
 * selector, and buying the difference back with another segment costs a whole
 * render for a second and a half of background.
 * @param totalSeconds - the length the card asked for.
 * @returns the seconds of each segment, in order.
 */
function loopSegments(totalSeconds: number): number[] {
  return montageShots(totalSeconds, 1, MAX_SHOT_SECONDS)
}

/**
 * The frames a closed loop spends on its own wrap: the loop is length − 5.
 *
 * `MiniMax H3 Loop Decode` keeps 17·pad_clips frames on each side as wrapped
 * context and hands back exactly the loop, so the five-frame tail of a 17k+5
 * latent is context, not part of the clip.
 */
const LOOP_CLOSED_TAIL_FRAMES = 5

/**
 * Whether the graph closes the loop itself, so it must not be closed again.
 *
 * `MiniMaxH3Loop` samples the latent with its end wrapped around to its start
 * and the matching decode returns exactly one loop: the clip begins where it
 * ends before any ffmpeg touches it. Recognised from the graph rather than
 * from a config field, so pointing an entry at such a file is all it takes;
 * the graph that pins the still as first and last frame keeps the old path.
 * @param workflow - the loaded loop graph.
 * @returns true when the sampler closes the loop.
 */
function closesItsOwnLoop(workflow: LoadedWorkflow): boolean {
  return Object.values(workflow.graph).some(node => node.class_type === 'MiniMaxH3Loop')
}

/**
 * Extract the last frame of a clip as a PNG image.
 *
 * Written outside the output directory: it is scratch the gallery must never
 * list, like the tail beside it.
 * @param videoPath - absolute path of the clip.
 * @returns the absolute path of the extracted PNG frame.
 */
async function extractLastFrame(videoPath: string): Promise<string> {
  return frameAt(videoPath, join(tmpdir(), `lastframe-${randomUUID()}.png`), { last: true })
}

/**
 * The soundtrack of a clip, as a file the voice graph can load.
 *
 * A voice change reads a track through the graph's audio loader, and the file
 * a user stages is usually a clip: the track is extracted rather than asked
 * for. The copy is written outside the output directory — the gallery lists
 * what is in there, and a soundtrack nobody asked for is not a creation — and
 * the caller removes it.
 * @param path - absolute path of the clip.
 * @returns the absolute path of the extracted track.
 */
async function audioTrackOf(path: string): Promise<string> {
  const out = join(tmpdir(), `voice-track-${randomUUID()}.wav`)
  return ffmpegTo(out, ['-v', 'error', '-y', '-i', path, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', out], 600_000)
}

/**
 * The mask of a zone edit: white inside the rectangle, black elsewhere, at the
 * photo's own size, written as a scratch PNG.
 */
async function writeRegionMask(region: ImagineRegion, width: number, height: number, path: string): Promise<void> {
  const left = Math.round(region.x * width)
  const top = Math.round(region.y * height)
  const boxW = Math.max(1, Math.round(region.w * width))
  const boxH = Math.max(1, Math.round(region.h * height))
  await ffmpegTo(path, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=black:s=${String(width)}x${String(height)}`,
    '-vf', `drawbox=x=${String(left)}:y=${String(top)}:w=${String(boxW)}:h=${String(boxH)}:color=white:t=fill`,
    '-frames:v', '1', path], 60_000)
}

/**
 * A painted mask at the photo's own size: the page paints at a reduced size,
 * so it is scaled up here and written as RGB, which the mask loader reads by
 * its red channel.
 */
async function writePaintedMask(bytes: Uint8Array, width: number, height: number, path: string): Promise<void> {
  const painted = `${path}.in.png`
  await writeFile(painted, bytes)
  try {
    await ffmpegTo(path, ['-hide_banner', '-loglevel', 'error', '-y', '-i', painted,
      '-vf', `scale=${String(width)}:${String(height)}:flags=bilinear,format=rgb24`, '-frames:v', '1', path], 60_000)
  } finally {
    await unlinkWithRetry(painted).catch(() => undefined)
  }
}

/**
 * Take one queued job through its graph, from its turn to its terminal state.
 *
 * The graph runs exactly as it was loaded: which recipe a run wants is decided
 * before it is queued (`pathHigh` picks the second graph; `highInputs` and
 * `steps.high` are written on the run's clone), so nothing is patched in
 * memory here — the old slow switch
 * (base weights, 24 steps) cost half an hour a window.
 * @param ctx - plugin context.
 * @param workflow - the graph it was queued with.
 * @param workflows - every graph this deployment loaded.
 * @param outputDir - the validated media output directory.
 * @param queuedJob - the job as it was queued.
 */
async function runImagineJob(
  ctx: ImagineHost,
  workflow: LoadedWorkflow,
  workflows: ImagineWorkflows,
  outputDir: string,
  queuedJob: ImagineJob,
): Promise<void> {
  // The GPU is serial, so a job can sit `queued` in this chain for minutes and
  // be cancelled long before its turn. Its promptId is still undefined then,
  // so `cancelImagineJob` had nothing to tell ComfyUI, and this function used
  // to start the run anyway: the tile left the studio while ComfyUI kept
  // generating. A cancel decided before the turn arrives ends the job here.
  // Nothing is registered before this check: the early return skips the
  // finally below, so a controller set first was never removed.
  const pending = getImagineJob(queuedJob.id)
  if (pending === undefined || pending.status === 'cancelled') {
    if (isLastOfStory(queuedJob)) forgetStoryPlan(queuedJob.storyId)
    return
  }
  const controller = startRunControl(queuedJob.id)
  patchJob(queuedJob.id, { status: 'running', startedAt: Date.now() })
  const state: RunState = {
    job: queuedJob,
    scratch: [],
    prompt: queuedJob.prompt,
    realistic: false,
    headless: false,
    musicSeconds: queuedJob.seconds ?? 60,
  }
  try {
    if (!await takeTurn(state)) return
    const job = state.job
    const sourceVideo = job.source === undefined ? undefined : join(outputDir, job.source)
    // Each file's header, read once per run however many passes want it.
    const pixelsOf = pixelCache()
    const scan: ScanRun = { ctx, workflows, outputDir, job, signal: controller.signal }
    if (job.action === 'scanFrame') {
      await runScanFrame(scan, workflow, sourceVideo)
      return
    }
    if (job.action === 'recreate' && sourceVideo !== undefined) {
      const recreation = await readRecreation(scan, sourceVideo)
      state.recreateMotion = recreation.motion
      state.job = { ...job, frame: recreation.frame }
    }
    /*
     * «Regenerate detail» usually comes without a line, and the prompt is
     * what guides the refiner's redraw: with a generic line the neckline and
     * lips change (measured 31/10/2026). The order is regenerate.ts's — the
     * user's line when there is one, the note the clip was born with, vision,
     * a neutral sentence — and the result is written on the job, so the tile
     * and the file's note say what was really asked.
     */
    if (state.job.action === 'regenerate' && sourceVideo !== undefined) {
      const resolved = await regeneratePrompt(ctx, state.job.source ?? '', sourceVideo, state.job.model, state.job.prompt)
      state.prompt = resolved
      state.job = { ...state.job, prompt: resolved }
      patchJob(queuedJob.id, { prompt: resolved })
    }
    const inputs = await readInputs(state, workflow, outputDir, sourceVideo, pixelsOf)
    await writePrompts(ctx, state, workflow, outputDir, inputs)
    const audio = await readAudio(ctx, state, workflow, workflows, outputDir, inputs.sourceKind, controller.signal)
    await renderAndFinish(ctx, state, workflow, workflows, outputDir, inputs, audio, pixelsOf, controller)
  } catch (error: unknown) {
    // The interrupt makes the run throw; that is the cancel (or the deadline)
    // landing, not a failure to report.
    if (isSettled(queuedJob.id)) return
    patchJob(queuedJob.id, {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    })
  } finally {
    endRunControl(queuedJob.id)
    // An extension's tail and frame, a zone edit's mask, the refiner's drafts
    // and every other helper file of this run: outside the gallery, but still
    // to be deleted.
    await dropScratch(state.scratch)
    // The last clip of a story is the last reader of its plan.
    if (isLastOfStory(state.job)) forgetStoryPlan(state.job.storyId)
  }
}

/**
 * What a clip of a story learns when its turn comes: the file it continues,
 * the beat it renders, the photo the plan put at its place.
 * @param state - the run; its job is updated in place.
 * @returns false when the run ends here (the chain was stopped, or broke).
 */
async function takeTurn(state: RunState): Promise<boolean> {
  const queuedJob = state.job
  let job = queuedJob
  if (job.follows !== undefined) {
    const parent = getImagineJob(job.follows)
    const produced = parent?.files?.find(file => file.kind === 'video')
      ?? parent?.files?.find(file => file.kind === 'image')
    if (parent?.status === 'cancelled') {
      // The chain was stopped upstream: this clip is not a failure, it is a
      // clip the user decided not to have.
      patchJob(job.id, { status: 'cancelled', updatedAt: Date.now() })
      return false
    }
    /*
     * A cut only waited for its turn: it starts from its own photo, so a
     * shot that failed upstream costs that shot and nothing else. A take's
     * clip has no such independence — it continues a file that was never
     * written — and dies with its parent.
     */
    if (job.cut === true && job.chain !== undefined && job.chain.index > 0
      && (parent === undefined || parent.status !== 'done')) {
      /*
       * The latent this shot was to continue was never saved: the shot
       * starts fresh from its photo instead of dying, and its first 22
       * frames — the head the chain would have pinned and trimmed — come
       * off after the run so the cut keeps its timeline. The join before it
       * is a cut rather than a continuation; a whole video is not lost to
       * one shot the card refused.
       */
      job = { ...job, chain: { ...job.chain, fresh: true } }
      state.headless = true
      setJobNotice(job.id, 'chain-broken')
    } else if (job.cut !== true) {
      if (parent === undefined || parent.status !== 'done' || produced === undefined) {
        patchJob(job.id, { status: 'error', error: message('job.previousClipMissing'), updatedAt: Date.now() })
        return false
      }
      job = { ...job, source: produced.name }
    }
  }
  // A redo carries its own line — the change the user asked for, or the beat
  // from the record — and the plan of a story still running must not undo it.
  const beat = job.redo === undefined ? await storyBeat(job) : undefined
  if (beat !== undefined && beat.trim().length > 0) job = { ...job, prompt: beat.trim() }
  // A montage's shot takes its photo from the plan, which may have cut the
  // photos in an order other than the one they were queued in.
  const planned = await storyShotSources(job)
  if (planned !== undefined) {
    job = {
      ...job,
      source: planned.source,
      ...planned.lastSource === undefined ? {} : { lastSource: planned.lastSource },
    }
    if (job.storyId !== undefined && job.storyIndex !== undefined && job.redo === undefined) {
      await updateStoryShot(job.storyId, job.storyIndex, { source: planned.source }).catch(() => undefined)
    }
  }
  // The studio shows what each clip was actually asked for, and the source
  // it ended up continuing.
  if (job !== queuedJob) {
    patchJob(job.id, {
      prompt: job.prompt,
      ...job.source === undefined ? {} : { source: job.source },
      ...job.lastSource === undefined ? {} : { lastSource: job.lastSource },
      ...job.chain === undefined ? {} : { chain: job.chain },
    })
  }
  state.job = job
  state.prompt = job.prompt
  return true
}

/**
 * Everything the graph reads besides the prompt, resolved at run time: the
 * clip or photo to load, the mask, the tail of a continuation, the upscale
 * target, the deadline of a run that chains its own clips.
 */
async function readInputs(
  state: RunState,
  workflow: LoadedWorkflow,
  outputDir: string,
  sourceVideo: string | undefined,
  pixelsOf: PixelsOf,
): Promise<RunInputs> {
  const job = state.job
  const sourceKind = job.source === undefined ? undefined : kindOf(job.source)
  /*
   * A clip with no soundtrack is a clip the long upscaler refuses: it loads
   * its input through VideoHelperSuite, whose audio extractor runs ffmpeg
   * for a stream that is not there and takes the graph down before its first
   * frame — "VHS failed to extract audio", measured 2026-10-15 on an
   * animated background, which is delivered without a soundtrack on purpose.
   * An upscale is handed a silent copy when the source has none; the copy is
   * temporary and the video stream is copied, not re-encoded.
   */
  const upscaleInput = sourceVideo !== undefined && job.action === 'upscale' && sourceKind === 'video'
    && !(await probeMedia(sourceVideo)).hasAudio
    ? await silentCopy(sourceVideo, job.id)
    : sourceVideo
  /*
   * A voice change's clip is read for its soundtrack and for nothing else:
   * the extracted track travels in the audio slot below, and handing the
   * graph the video as well failed the run with "workflow has no LoadVideo
   * node for the input video" — the voice graph has no video loader at all
   * (measured 2026-10-17).
   */
  let inputVideo = upscaleInput === undefined || sourceKind !== 'video'
    || job.action === 'extend' || job.action === 'voice' || job.action === 'recreate'
    /*
     * «Regenerate detail» uploads its own draft window by window: the whole
     * file is not needed here, and a long clip would be a wasted upload.
     */
    || job.action === 'regenerate'
    ? undefined
    : await resolveInputVideo({ path: upscaleInput }, outputDir)
  if (upscaleInput !== sourceVideo && upscaleInput !== undefined) {
    await unlinkWithRetry(upscaleInput).catch(() => undefined)
  }
  /*
   * An object swap's input image is its photo, not its source: the plate
   * travels as the video and is read by the canvas and the prompt passes
   * below, so the two run the way any other job reads its own inputs.
   *
   * A recreation animates the frame the run drew, not the clip it was read
   * from: `source` stays the reference clip so the job can still say what it
   * recreated and where its soundtrack comes from.
   */
  const drawnFrame = job.action === 'recreate' && job.frame !== undefined ? join(outputDir, job.frame) : undefined
  const imagePath = job.action === 'objectSwap' || job.action === 'swapPerson'
    ? job.reference === undefined ? undefined : join(outputDir, job.reference)
    : drawnFrame !== undefined
      ? drawnFrame
      : job.source === undefined || sourceKind !== 'image'
        ? undefined
        : join(outputDir, job.source)
  /*
   * The photo, its pixels, the second image and an edit's reference are four
   * independent local reads: taken together rather than one after the other.
   *
   * The photo's own ratio is read here because this is the last place the
   * file is a path: what renders a video next holds only bytes, and a decoder
   * is one more thing to get wrong. Unreadable pixels are not an error — the
   * run falls back to the graph's own aspect, which is what it did before.
   *
   * A zone edit's mask travels in the second image slot, the one a clip uses
   * for its last frame: the region graph pins it on its mask loader (below).
   * An edit's reference photo (Grok's «+») is Krea 2's second image.
   */
  const [inputImage, imagePixels, lastSourceImage, refImage] = await Promise.all([
    imagePath === undefined ? undefined : resolveInputImage({ path: imagePath }, outputDir),
    imagePath === undefined ? undefined : pixelsOf(imagePath, 'image').catch(() => undefined),
    job.lastSource === undefined
      ? undefined
      : resolveInputImage({ path: join(outputDir, job.lastSource) }, outputDir).catch(() => undefined),
    job.action === 'remix' && job.reference !== undefined
      ? resolveInputImage({ path: join(outputDir, job.reference) }, outputDir)
      : undefined,
  ])
  const imageRatio = imagePixels === undefined || !('width' in imagePixels)
    ? undefined
    : ratioOf(imagePixels.width, imagePixels.height)
  let lastImage: RunInputs['lastImage'] = lastSourceImage
  if (job.action === 'remix' && (job.region !== undefined || job.painted === true) && job.source !== undefined) {
    const pixels = await pixelsOf(join(outputDir, job.source), 'image')
    if (!('width' in pixels)) throw new Error(message('still.sizeUnreadable'))
    const maskPath = join(tmpdir(), `imagine-region-mask-${job.id}.png`)
    if (job.painted === true) {
      const bytes = takePaintedMask(job.id)
      if (bytes === undefined) throw new Error(message('job.maskLostOnRestart'))
      await writePaintedMask(bytes, pixels.width, pixels.height, maskPath)
    } else if (job.region !== undefined) {
      await writeRegionMask(job.region, pixels.width, pixels.height, maskPath)
    }
    state.scratch.push(maskPath)
    lastImage = { bytes: new Uint8Array(await readFile(maskPath)), name: `region-mask-${job.id}.png` }
  }
  /*
   * 'extend' hands the graph the TAIL of the source clip, not a frame of it.
   * H3 anchors a 22-frame guide with its soundtrack at frame 0, so the
   * continuation carries the motion that was under way and the sound that
   * was playing; a single still carried neither, and the seam showed it.
   * The last frame is still extracted, for the vision pass to read — from
   * the tail, which ends on the same frame and is a few seconds to decode
   * rather than the whole clip.
   */
  let extendSource: RunInputs['extendSource']
  let extendFrame: string | undefined
  if (job.action === 'extend' && job.source !== undefined && sourceKind === 'video') {
    const videoPath = join(outputDir, job.source)
    // One ffprobe for the length and the canvas.
    const probe = await probeMedia(videoPath)
    extendSource = {
      duration: probe.duration,
      // The continuation renders on the source's own canvas: the composer's
      // aspect selector describes the next clip the user might make, not the
      // one being continued, and a mismatch is a cut in the middle of a shot.
      ...probe.width === undefined || probe.height === undefined
        ? {}
        : {
          pixels: { width: probe.width, height: probe.height },
          size: formatSize(h3Canvas(probe.width, probe.height)),
        },
    }
    const extendTail = await videoTail(videoPath, probe)
    state.scratch.push(extendTail)
    // A chained continuation reads the whole clip (the Context Loop takes its
    // context from it and lays it in front of the new scenes); a single one, the tail.
    inputVideo = await resolveInputVideo({ path: workflow.planJson === undefined ? extendTail : videoPath }, outputDir)
    extendFrame = await extractLastFrame(extendTail)
    state.scratch.push(extendFrame)
  }
  // Upscales go to AT MOST 2x the source resolution (e.g. 1080x1920 -> 2160x3840),
  // not to the fixed 4096 side that produces 2304x4096. The 2x is still
  // capped at UPSCALE_MAX_SIDE: the guard looks at the short side, so a
  // panoramic image passes it and would ask for an out-of-scale run.
  let resolutionMax: number | undefined
  if (job.action === 'upscale' && job.source !== undefined && (sourceKind === 'image' || sourceKind === 'video')) {
    const pixels = await pixelsOf(join(outputDir, job.source), sourceKind)
    // Clips were measured but never given a target, so the graph kept its
    // hardwired 1080 and a 736x1280 source came back smaller than the 2x the
    // button promises, for the same GPU time.
    if ('width' in pixels) {
      resolutionMax = job.upscaleTo === undefined
        ? upscaleTargetFor(pixels.width, pixels.height, sourceKind)
        : upscaleLongFor(pixels.width, pixels.height, job.upscaleTo, sourceKind)
    }
  }
  /*
   * «Character swap»: Openjutsu's graph renders the whole clip in one prompt,
   * a 6 s clip at a time with 39 frames of overlap — about one clip per 4.4 s
   * of video. Each gets half an hour, far more than a slow card needs at the
   * graph's 736p, so a long clip is never cut off by ComfyUI's single-run
   * deadline while a stuck run still ends.
   */
  const plateSeconds = (job.action === 'swapPerson' || job.action === 'objectSwap') && sourceVideo !== undefined
    ? (await probeMedia(sourceVideo)).duration
    : undefined
  const chainedSeconds = !chainsItsOwnClips(job, workflow) ? undefined : plateSeconds ?? job.seconds
  const timeoutMs = chainedSeconds === undefined
    ? undefined
    : Math.ceil(Math.max(1, chainedSeconds) / 4.4) * 30 * 60_000
  return {
    sourceKind,
    sourceVideo,
    ...inputImage === undefined ? {} : { inputImage },
    ...inputVideo === undefined ? {} : { inputVideo },
    ...lastImage === undefined ? {} : { lastImage },
    ...refImage === undefined ? {} : { refImage },
    ...drawnFrame === undefined ? {} : { drawnFrame },
    ...imageRatio === undefined ? {} : { imageRatio },
    ...extendSource === undefined ? {} : { extendSource },
    ...extendFrame === undefined ? {} : { extendFrame },
    ...resolutionMax === undefined ? {} : { resolutionMax },
    ...timeoutMs === undefined ? {} : { timeoutMs },
    ...plateSeconds === undefined ? {} : { plateSeconds },
  }
}

/** What a prompt writer reads: the run, its graph and its resolved inputs. */
interface PromptPass {
  readonly ctx: ImagineHost
  readonly state: RunState
  readonly workflow: LoadedWorkflow
  readonly outputDir: string
  readonly inputs: RunInputs
}

/**
 * The texts the sampler is given, written around the user's line.
 *
 * Neither sampler reads the one sentence the composer hands over the way the
 * studio implies: a clip is conditioned on a structured H3 prompt, and the
 * edit graph grounds its instruction on the picture, so "Redraw this image as
 * a Studio Ghibli anime frame" says nothing about what is in the frame. Have
 * the vision model read the source and write the prompt around the user's
 * line; the raw text stays the fallback, so a missing vision override or a
 * slow reply costs grounding, not the run.
 *
 * One writer per action ({@link PROMPT_WRITERS}); an action with none is
 * rendered on the line the user wrote.
 */
async function writePrompts(
  ctx: ImagineHost,
  state: RunState,
  workflow: LoadedWorkflow,
  outputDir: string,
  inputs: RunInputs,
): Promise<void> {
  await PROMPT_WRITERS[state.job.action]?.({ ctx, state, workflow, outputDir, inputs })
}

/**
 * Whether the graph has a pin for the texts an object swap writes.
 *
 * A graph that carries its own prompt has no pin for these texts, and the
 * vision pass would spend minutes writing what nothing reads.
 */
function readsSwapTexts(workflow: LoadedWorkflow): boolean {
  return workflow.subjectText !== undefined || workflow.referenceText !== undefined
}

/**
 * Put the texts an object swap's pass wrote on the run and on the live job.
 *
 * With nothing written the graph's own placeholders stay. The shot account is
 * not a pin of any swap graph (they plan their own scenes): it is filed as
 * the written prompt, so the tile and the file's note say what was read.
 * @param state - the run.
 * @param written - the texts, or undefined when the pass fell through.
 */
function applySwapTexts(
  state: RunState,
  written: { readonly track: string; readonly reference: string; readonly scene: string } | undefined,
): void {
  const job = state.job
  if (written === undefined) return
  state.subjectText = written.track
  state.referenceText = written.reference
  state.writtenPrompt = written.scene
  patchJob(job.id, {
    writtenPrompt: written.scene, subjectText: written.track, referenceText: written.reference,
  })
}

/**
 * «Object swap»: the reference and shot documents, written per MODE — the
 * subject is an object, so there is no identity to read. The mode decides the task sentence and the retention analysis
 * (object-swap-texts.ts); the vision model writes only what only it can see:
 * the tracker phrase and the account of the take.
 */
async function writeObjectSwapPrompt({ ctx, state, workflow, outputDir, inputs }: PromptPass): Promise<void> {
  const job = state.job
  /*
   * The box of «add an object»: it is the graph's mask, so it must be
   * written even when the vision model does not answer — it is not a text, it
   * is the geometry of the edit. The centre of the frame is the default.
   */
  if ((job.objectMode ?? 'change') === 'add') {
    state.placementText = placementKeyframes(job.placement ?? DEFAULT_OBJECT_PLACEMENT)
  }
  if (!readsSwapTexts(workflow) || job.source === undefined) return
  const plate = inputs.sourceVideo ?? join(outputDir, job.source)
  const written = await writeObjectSwapTexts(ctx, {
    clipPath: plate,
    ...job.reference === undefined ? {} : { referencePath: join(outputDir, job.reference) },
    mode: job.objectMode ?? 'change',
    intent: job.prompt,
    duration: inputs.plateSeconds ?? (await probeMedia(plate)).duration,
    chosen: job.model,
  })
  applySwapTexts(state, written)
}

/**
 * The picture a vision pass reads, when this run has one: a continuation's
 * last frame, a recreation's drawn frame, or the photo it animates or edits.
 * @returns the absolute path, or undefined when the run has nothing to read.
 */
function visionSourceOf({ state, outputDir, inputs }: PromptPass): string | undefined {
  const job = state.job
  const sourcePath = job.action === 'extend'
    ? inputs.extendFrame
    : inputs.drawnFrame ?? (job.source === undefined ? undefined : join(outputDir, job.source))
  return sourcePath !== undefined && (inputs.inputImage !== undefined || job.action === 'extend')
    ? sourcePath
    : undefined
}

/** File the prompt a vision pass wrote on the live job, so the tile can show it. */
function fileWrittenPrompt(state: RunState): void {
  if (state.writtenPrompt !== undefined) patchJob(state.job.id, { writtenPrompt: state.writtenPrompt })
}

/** A clip, a continuation or a background: the H3 prompt, written from the picture. */
async function writeClipPrompt(pass: PromptPass): Promise<void> {
  const { ctx, state, workflow } = pass
  const job = state.job
  const sourcePath = visionSourceOf(pass)
  if (sourcePath === undefined) return
  // A continuation is written against the clip it follows: the airlock,
  // and the soundtrack of that clip when the job that made it is still
  // in the map.
  const parentPrompt = job.action === 'extend' && job.source !== undefined
    ? jobThatProduced(job.source)?.writtenPrompt ?? await recallWrittenPrompt(job.source)
    : undefined
  const kind = job.action === 'extend' || job.action === 'loop' ? job.action : 'video'
  /*
   * A chained clip (the Context Loop plan): one prompt per scene of at most
   * six seconds, written in one look at the opening frame.
   */
  if (workflow.planJson !== undefined) {
    const scenes = chainSceneSeconds(job.seconds ?? 5)
    const chain = await writeH3ChainPrompts(ctx, sourcePath, job.prompt, scenes, job.model, kind === 'extend' ? soundtrackOf(parentPrompt) : undefined, kind === 'loop')
    if (chain !== undefined) {
      state.realistic = chain.realistic
      state.chainPrompts = chain.prompts.map(prompt => withRealism(prompt, chain.realistic, workflow))
      state.prompt = state.chainPrompts[0] ?? state.prompt
      state.writtenPrompt = state.chainPrompts.map((prompt, index) => `— scene ${String(index + 1)} —\n${prompt}`).join('\n\n')
    }
    fileWrittenPrompt(state)
    return
  }
  // A loop's is one segment's length, not the whole chain's: the description
  // has to cover the clip the sampler renders, and the loop's own instruction
  // says the motion comes back to where it started.
  const seconds = kind === 'loop'
    ? loopSegments(job.seconds ?? MAX_SHOT_SECONDS)[0] ?? MAX_SHOT_SECONDS
    : job.seconds ?? 5
  const clip = await writeH3Prompt(ctx, sourcePath, job.prompt, seconds, kind, {
    ...kind === 'extend' ? { carried: soundtrackOf(parentPrompt) } : {},
    chosen: job.model,
  })
  if (clip !== undefined) {
    /*
     * The clip being continued already decided how its people are
     * rendered. Re-judging one frame can tip the verdict the other way
     * halfway into a chain, and the LoRA restyles the faces when it
     * does, so the parent's answer wins whenever it can be read.
     */
    const inherited = parentPrompt === undefined || workflow.realism === undefined
      ? undefined
      : parentPrompt.includes(workflow.realism.token)
    state.realistic = inherited ?? clip.realistic
    // The token rides in the prompt the studio shows, so a clip whose
    // people were restyled says so where the run can be read back.
    state.prompt = withRealism(clip.prompt, state.realistic, workflow)
    state.writtenPrompt = state.prompt
  }
  /*
   * Otherwise the vision pass fell through, and the prompt that reaches the
   * sampler stays the user's own line — bare, with nothing appended. It used
   * to carry "— NIENTE VOCE, NIENTE CANTO: solo ambiente e musica
   * strumentale", and H3 read that Italian direction out loud: the clip spoke
   * the instruction instead of applying it (heard on 2026-10-31).
   */
  fileWrittenPrompt(state)
}

/**
 * A recreation's prompt is written for this picture, from the action the
 * reading described and the user's own direction: it is neither the reference
 * clip's description passed through, nor the line the user typed.
 */
async function writeRecreatePrompt(pass: PromptPass): Promise<void> {
  const { ctx, state, workflow } = pass
  const job = state.job
  const sourcePath = visionSourceOf(pass)
  if (sourcePath === undefined) return
  const brief = recreateBrief(job.prompt, state.recreateMotion)
  const clip = await writeH3Prompt(ctx, sourcePath, brief, job.seconds ?? 5, 'video', { chosen: job.model })
  if (clip !== undefined) {
    state.realistic = clip.realistic
    state.prompt = withRealism(clip.prompt, clip.realistic, workflow)
  } else {
    // The reading of the frame failed, and the brief is better than a bare line.
    state.prompt = brief
  }
  state.writtenPrompt = state.prompt
  fileWrittenPrompt(state)
}

/** An edit's instruction, grounded on the photo it edits. */
async function writeRemixPrompt(pass: PromptPass): Promise<void> {
  const { ctx, state } = pass
  const job = state.job
  const sourcePath = visionSourceOf(pass)
  if (sourcePath === undefined) return
  const written = await writeEditPrompt(ctx, sourcePath, job.prompt, job.model)
  if (written !== undefined) {
    state.prompt = written
    state.writtenPrompt = written
  }
  fileWrittenPrompt(state)
}

/**
 * The music graph wants two texts in a shape the studio never wrote: a
 * caption in three sections and lyrics with their structure tags, which
 * MiniMax's own template calls the only executable structure a song has. A
 * one-line caption and an undivided block of words is that song with
 * neither: the user heard the difference as "qualita davvero pessima".
 *
 * The song's length: the user's when they said one, otherwise the
 * writer's, from the words; sixty seconds only when nobody could decide.
 */
async function writeMusicPrompt({ ctx, state }: PromptPass): Promise<void> {
  const job = state.job
  const score = await writeMusicScore(ctx, job.prompt, job.lyrics ?? '', job.seconds, job.model, job.singer)
  if (score !== undefined) {
    state.prompt = score.caption
    state.musicLyrics = score.lyrics
    state.writtenPrompt = score.caption
    if (job.seconds === undefined && score.seconds !== undefined) state.musicSeconds = score.seconds
    state.job = { ...job, seconds: state.musicSeconds }
    patchJob(job.id, { writtenPrompt: score.caption, seconds: state.musicSeconds })
  } else {
    /*
     * The song still runs, on the line the user wrote: a caption in one
     * sentence and lyrics with no section tags, which is the song the
     * model cannot structure. Said out loud because the difference is
     * audible and nothing else reports it — a reading model that went
     * down took the captions with it for hours, and the only symptom the
     * user had was "why don't caption and tags work anymore?".
     */
    setJobNotice(job.id, 'caption-plain')
  }
}

/** The prompt writer of each action that has one; the rest run on the user's line. */
const PROMPT_WRITERS: Partial<Record<ImagineAction, (pass: PromptPass) => Promise<void>>> = {
  objectSwap: writeObjectSwapPrompt,
  video: writeClipPrompt,
  extend: writeClipPrompt,
  loop: writeClipPrompt,
  recreate: writeRecreatePrompt,
  remix: writeRemixPrompt,
  music: writeMusicPrompt,
}

/**
 * The audio the graph is handed: a voice change's track, or the slice of the
 * song a shot has to sing.
 */
async function readAudio(
  ctx: ImagineHost,
  state: RunState,
  workflow: LoadedWorkflow,
  workflows: ImagineWorkflows,
  outputDir: string,
  sourceKind: MediaKind | undefined,
  signal: AbortSignal,
): Promise<RunAudio> {
  const job = state.job
  /*
   * A voice change reads its own source: the track to convert, uploaded the
   * way a source image is. Separate from `sings`, which is a track a clip
   * has to sing while it is generated.
   *
   * A clip is a track with pictures on it: its soundtrack is extracted here,
   * at run time, so the minutes it spends queued do not make a copy of a
   * file that may be deleted before its turn comes.
   */
  if (job.action === 'voice' && job.source !== undefined && workflow.audioNodeId !== undefined) {
    const safe = safeBasename(job.source)
    if (safe !== undefined) {
      const track = sourceKind === 'video' ? await audioTrackOf(join(outputDir, safe)) : join(outputDir, safe)
      if (track !== join(outputDir, safe)) state.scratch.push(track)
      return { bytes: await readFile(track), name: basename(track), sings: false, silentSlice: false }
    }
  }
  /*
   * The seconds of the track this clip sings. Read here rather than at queue
   * time: a chain can wait half an hour on the GPU, and the file is only
   * needed when the run actually starts.
   */
  if (job.sings === undefined || workflow.songAudio === undefined) return { sings: false, silentSlice: false }
  let songBytes: Uint8Array | undefined
  let voiceFile: string | undefined
  let silentSlice = false
  // The vocal drives the mouth; the mix stays the soundtrack.
  const vocals = await vocalsOf(ctx, workflows, outputDir, job.sings, {
    onPrompt: (promptId) => { setJobPromptId(ctx, job.id, promptId) },
    signal,
  })
  for (const sung of vocals === undefined ? [job.sings] : [vocals, job.sings]) {
    const safe = safeBasename(sung)
    if (safe === undefined) continue
    try {
      songBytes = await readFile(join(outputDir, safe))
      voiceFile = join(outputDir, safe)
      break
    } catch {
      // A vocal deleted from the gallery is forgotten, and this shot falls
      // back to the mix rather than losing its guide until the next
      // restart. The mix itself gone between the queue and the run: the
      // clip is generated with its own audio, and the song still goes
      // over the cut.
      if (sung === vocals) vocalsBySong.delete(job.sings)
    }
  }
  if (voiceFile !== undefined) {
    // Only the part this shot delivers: a chained shot's first 22 frames
    // are the previous shot's, already sung or not sung there.
    silentSlice = isSilent(await loudnessOf(
      voiceFile,
      voiceOffsetOf(job),
      renderedSeconds(job.seconds ?? 5) - voiceHeadOf(job),
    ))
  }
  /*
   * Nothing to sing in this shot: the guide is the mix, not the silent
   * vocal. Handed silence, H3 invents a voice and the mouth sings it —
   * measured 2026-09-08 on a sixteen-second intro, with the singing and
   * the listening document alike (-14 dBFS of invented audio either way).
   * Handed the instrumental music instead, the same document keeps the
   * mouth closed for the whole shot, and the music is copied.
   */
  const mix = safeBasename(job.sings)
  if (silentSlice && mix !== undefined) {
    try {
      songBytes = await readFile(join(outputDir, mix))
    } catch {
      // The mix is gone: the vocal slice stays as the guide, which is what
      // this shot would have sung before the probe existed.
    }
  }
  if (songBytes === undefined) return { sings: false, silentSlice }
  /*
   * A clip that has to sing must be told so in words.
   *
   * The audio guide alone does not open the mouth: given a track and a
   * prompt about the camera, H3 renders the camera move and generates a
   * matching soundtrack with the subject's lips closed — which is what the
   * first eleven-shot video did for its whole length. Adding the direction
   * and changing nothing else made the same segment sing. Written in English
   * because that is the language the model's own prompts are written in.
   */
  state.prompt = silentSlice ? listeningPrompt(state.prompt) : singingPrompt(state.prompt)
  return {
    bytes: songBytes,
    name: job.sings,
    sings: true,
    silentSlice,
    ...voiceFile === undefined ? {} : { voiceFile },
  }
}

/**
 * The seconds at the head of a sung shot that belong to the shot before it:
 * a chained shot past the first opens on the previous shot's 22 guide frames.
 * @param job - the sung shot.
 * @returns the head in seconds, zero for a first or unchained shot.
 */
function voiceHeadOf(job: ImagineJob): number {
  return job.chain !== undefined && job.chain.index > 0 ? GUIDE_SECONDS : 0
}

/**
 * Where in the vocal a sung shot's own part starts: its place in the song
 * plus the head it shares with the shot before it. One spelling for the
 * silence probe and the lipsync probe, which must read the same slice.
 * @param job - the sung shot.
 * @returns the offset into the vocal, in seconds.
 */
function voiceOffsetOf(job: ImagineJob): number {
  return (job.songStart ?? 0) + voiceHeadOf(job)
}

/**
 * The aspect a render should use, from the photo it animates.
 *
 * Asked for, the composer's choice wins — but it is still measured, so the run
 * can say the photo and the clip disagree instead of coming back squashed. Not
 * asked for, the closest aspect the node accepts is chosen, which is what stops
 * an H3 graph from stretching a square photo into its 9:16 default.
 * @param ctx - the host context, for ComfyUI's node definitions.
 * @param workflow - the graph about to run.
 * @param asked - the aspect the job named, when it named one.
 * @param imageRatio - the photo's width over height, when it has been read.
 * @returns the aspect to write into the graph, and whether the photo does not fit it.
 */
async function aspectForImage(
  ctx: ImagineHost,
  workflow: LoadedWorkflow,
  asked: string | undefined,
  imageRatio: number | undefined,
): Promise<{ readonly aspect: string | undefined; readonly mismatched: boolean }> {
  if (imageRatio === undefined) return { aspect: asked, mismatched: false }
  if (asked !== undefined) {
    const gap = gapOf(imageRatio, asked)
    return { aspect: asked, mismatched: gap !== undefined && gap > VISIBLE_RATIO_GAP }
  }
  const pin = workflow.aspectRatio
  const node = pin === undefined ? undefined : workflow.graph[pin.nodeId]
  if (pin === undefined || node === undefined) return { aspect: undefined, mismatched: false }
  let labels: readonly string[]
  try {
    labels = await ctx.comfy.nodeOptions(node.class_type, pin.field) ?? []
  } catch {
    // A node ComfyUI cannot describe is not a reason to fail a render.
    return { aspect: undefined, mismatched: false }
  }
  const chosen = closestLabel(imageRatio, labels)
  if (chosen === undefined) return { aspect: undefined, mismatched: false }
  return { aspect: chosen, mismatched: (gapOf(imageRatio, chosen) ?? 0) > VISIBLE_RATIO_GAP }
}

/** The name a run's result is declared under, and what kind of file it is. */
interface RunOutput {
  readonly tool: string
  readonly output: 'image' | 'video' | 'audio'
  readonly ext: string
}

/**
 * What a run's result is called and what it is: the action's own entry, an
 * edit, a personal workflow's declared output, or an upscale named by its
 * source.
 */
function outputOf(job: ImagineJob, workflow: LoadedWorkflow, sourceKind: MediaKind | undefined): RunOutput {
  const runs = ACTION_RUNS[job.action]
  const tool = job.action === 'custom'
    ? 'custom_workflow'
    : job.action === 'remix'
    ? 'edit_image'
    : runs?.tool ?? (sourceKind === 'video' ? 'upscale_video' : 'upscale_image')
  const output = job.action === 'custom'
    ? (workflow as { readonly customOutput?: 'image' | 'video' }).customOutput ?? 'image'
    : job.action === 'remix' ? 'image' : runs?.output ?? (sourceKind === 'video' ? 'video' : 'image')
  const ext = workflow.outputExt ?? (output === 'video' ? 'mp4' : output === 'audio' ? 'mp3' : 'png')
  return { tool, output, ext }
}

/**
 * A shot of a music video is delivered under its number — 03of10 — so it
 * can be told apart on the board and asked for by number in the chat,
 * and its story's record can find it again for a redo.
 */
function deliveredShotOf(job: ImagineJob): DeliveredShot | undefined {
  return job.cut === true && job.sings !== undefined
    && job.storyId !== undefined && job.storyIndex !== undefined && job.storyCount !== undefined
    ? { storyId: job.storyId, index: job.storyIndex, count: job.storyCount }
    : undefined
}

/**
 * The file slots of an uploaded card: the job carries the names in the
 * gallery, here they become bytes and the graph receives them on the node
 * that expects them.
 */
async function customFilesOf(job: ImagineJob, outputDir: string): Promise<CustomFile[] | undefined> {
  if (job.customFiles === undefined) return undefined
  return await Promise.all(Object.entries(job.customFiles).map(async ([node, name]) => {
    const file = safeBasename(name)
    if (file === undefined) throw new ComfyError(`bad file name for node ${node}`, 'COMFY_GRAPH_REJECTED')
    const bytes = await readFile(join(outputDir, file))
    const kind = kindOf(file)
    if (kind === undefined) throw new ComfyError(`unreadable file for node ${node}: ${file}`, 'COMFY_GRAPH_REJECTED')
    return { node, name: file, kind, bytes }
  }))
}

/** One file slot of a personal workflow, read for its node. */
interface CustomFile {
  readonly node: string
  readonly name: string
  readonly kind: MediaKind
  readonly bytes: Uint8Array
}

/**
 * The pieces of a chained render, dissolved into one file under the name
 * the job declared, so the gallery lists it as one run's result.
 *
 * One piece is joined by nothing: it goes on as the sampler wrote it
 * rather than through the concat, which would re-encode a generation of
 * quality away for nothing. The join and the pieces are scaffolding and go
 * once the finished file is in place — and stay if anything threw, which is
 * where they are still worth something.
 *
 * `fade` is the seconds each join dissolves over: «Regenerate detail»
 * dissolves its windows over their one-second overlap; the loop brings no
 * overlap and keeps the default.
 */
function assemblerFor(outputDir: string, out: RunOutput, args: Record<string, unknown>): Assemble {
  return async (parts, lengths, errors, finish, fade) => {
    const first = parts[0]
    if (first === undefined) throw new Error(errors.none)
    const final = freeOutputPath(declaredOutputPath(outputDir, out.tool, out.ext, args))
    let assembled = first
    if (parts.length > 1) {
      const canvas = await probePixels(first, 'video')
      if (!('width' in canvas)) throw new Error(errors.unmeasured)
      assembled = await joinCuts(parts, canvas.width, canvas.height, outputDir, lengths, fade)
    }
    const finished = await finish(assembled)
    await renameWithRetry(finished, final)
    if (finished !== assembled) await unlinkWithRetry(assembled).catch(() => undefined)
    await Promise.all(parts.map(async part => unlinkWithRetry(part).catch(() => undefined)))
    return [{ path: final, kind: 'video' }]
  }
}

/** Everything one render of the run's graph is built from. */
interface RenderSetup {
  readonly ctx: ImagineHost
  readonly state: RunState
  readonly workflow: LoadedWorkflow
  readonly outputDir: string
  readonly inputs: RunInputs
  readonly audio: RunAudio
  readonly out: RunOutput
  readonly args: Record<string, unknown>
  readonly aspect: string | undefined
  readonly shotPath: string | undefined
  readonly customFiles: readonly CustomFile[] | undefined
  readonly signal: AbortSignal
}

/**
 * One render of the run's graph, with everything the run resolved.
 *
 * `over` carries what one segment of an animated background changes
 * against the job's own values: its own length and its own file. A window
 * of «Regenerate detail» adds the draft it renders from. Every other
 * action renders once and leaves it out.
 */
function rendererFor(setup: RenderSetup): Render {
  const { ctx, state, workflow, outputDir, inputs, audio, out, args, aspect, shotPath, customFiles, signal } = setup
  const job = state.job
  const effectivePrompt = state.prompt
  const { resolutionMax, inputImage, lastImage, refImage } = inputs
  /*
   * The clip one render reads: a window of «Regenerate detail» brings its
   * own draft, every other render reads the job's input.
   */
  const renderVideo = (video?: ResolvedInputVideo): { bytes: Uint8Array; name: string } | undefined => {
    const chosen = video ?? inputs.inputVideo
    return chosen === undefined ? undefined : { bytes: chosen.bytes, name: chosen.name }
  }
  return async (link, seed, over) => {
    const seconds = over?.seconds ?? job.seconds
    return runWorkflow(
      ctx,
      workflow,
      outputDir,
      {
        /*
         * A card that exposes the prompt among its controls (the lookbook: the
         * title is a catalogue entry) must not have it emptied by a text field
         * left blank: with no written prompt the graph keeps its own.
         */
        ...job.action === 'custom' && effectivePrompt === '' ? {} : { prompt: effectivePrompt },
        seed,
        // «Quality: High» / «Speed: Slow»: the graph was already chosen
        // (`pathHigh` when the entry has one); here they write the entry's
        // `highInputs` and raise the step count to `steps.high` when the
        // graph that runs declares them. Absent, the file's own recipe.
        ...job.quality === undefined ? {} : { quality: job.quality },
        ...job.speed === undefined ? {} : { speed: job.speed },
        ...resolutionMax === undefined ? {} : { resolutionMax },
        ...job.size === undefined ? {} : { size: job.size },
        ...inputs.extendSource?.size === undefined ? {} : { size: inputs.extendSource.size },
        ...aspect === undefined ? {} : { aspectRatio: aspect },
        // The card's controls: values for this run only, written on the clone.
        ...job.customFields === undefined ? {} : { fields: job.customFields },
        // A segment's own length wins: a loop asked for without `seconds`
        // still renders the length it was planned at.
        ...seconds === undefined ? {} : { seconds },
        ...job.megapixels === undefined ? {} : { megapixels: job.megapixels },
        ...job.action === 'music' ? { lyrics: state.musicLyrics ?? job.lyrics ?? '', seconds: state.musicSeconds } : {},
        ...job.action === 'voice'
          ? {
            ...job.voice === undefined ? {} : { voice: job.voice },
            ...job.pitch === undefined ? {} : { pitch: job.pitch },
          }
          : {},
        ...!audio.sings
          ? {}
          : {
            songStart: job.songStart ?? 0,
            // Half a second past the clip, so the guide never runs out before
            // the video does and the last words are not cut mid-syllable. Never
            // shorter than the clip: a slice cut at the song's end changed the
            // reference geometry and the pinned head of a chained shot did not
            // hold (a 44-point jump at the join, measured 2026-09-08). The
            // chain is sized to end with the song instead — see montageShots.
            songDuration: (job.seconds ?? 5) + 0.5,
            ...link === undefined ? {} : { chain: link },
          },
        ...state.subjectText === undefined ? {} : { subjectText: state.subjectText },
        ...state.referenceText === undefined ? {} : { referenceText: state.referenceText },
        ...state.placementText === undefined ? {} : { placementText: state.placementText },
        ...job.action === 'swapPerson' ? { noLipSync: job.lipSync === false } : {},
        ...job.planResolution === undefined ? {} : { planResolution: job.planResolution },
        // A chained clip: the plan of its scenes and the run its checkpoints go under.
        ...workflow.planJson === undefined ? {} : {
          planJson: chainPlanJson(state.chainPrompts ?? [effectivePrompt], chainSceneSeconds(job.seconds ?? 5), job.action === 'extend' ? GUIDE_SECONDS : 0),
          runName: `imagine_${job.id}`,
        },
        realistic: state.realistic,
      },
      {
        declared: shotPath ?? over?.path ?? declaredOutputPath(outputDir, out.tool, out.ext, args),
        inputImage: inputImage === undefined ? undefined : { bytes: inputImage.bytes, name: inputImage.name },
        ...customFiles === undefined ? {} : { customFiles },
        inputVideo: renderVideo(over?.video),
        inputAudio: audio.bytes === undefined ? undefined : { bytes: audio.bytes, name: audio.name ?? job.source ?? '' },
        lastImage: lastImage === undefined ? undefined : { bytes: lastImage.bytes, name: lastImage.name },
        refImage: refImage === undefined ? undefined : { bytes: refImage.bytes, name: refImage.name },
        ...inputs.timeoutMs === undefined ? {} : { timeoutMs: inputs.timeoutMs },
        onPrompt: (promptId) => { setJobPromptId(ctx, job.id, promptId) },
        onRestart: () => { setJobNotice(job.id, 'comfy-restart') },
        // ComfyUI missing nodes or models: the chat asks, then shows the install.
        setup: {
          approve: plan => waitForSetupApproval(job.id, plan, signal),
          progress: (state) => {
            setSetupProgress(job.id, { stage: state.stage, percent: state.percent, ...state.etaSeconds === undefined ? {} : { etaSeconds: state.etaSeconds } })
          },
          done: () => { endSetup(job.id) },
        },
        signal,
      },
    )
  }
}

/** What a renderer of the job's main render reads. */
interface RenderRun {
  readonly ctx: ImagineHost
  readonly state: RunState
  readonly workflow: LoadedWorkflow
  readonly outputDir: string
  readonly inputs: RunInputs
  readonly seed: number
  readonly signal: AbortSignal
  readonly render: Render
  readonly assemble: Assemble
}

/** A render made of segments, each its own run of the graph, joined into one file. */
interface Segments {
  readonly count: number
  /** What segment `index` renders over the job's own values, prepared when its turn comes. */
  readonly over: (index: number) => Promise<RenderOver>
  /** The length segment `index` delivers, which the dissolve is sized on. */
  readonly length: (index: number) => number
  /** Said when a segment produced no clip. */
  readonly missing: string
  readonly errors: { readonly none: string; readonly unmeasured: string }
  /** The rendered segments are scratch: removed however the run ends. */
  readonly scratch?: boolean
  /** Free the card between segments: each one loads the same models again. */
  readonly freeBetween?: boolean
  readonly finish: (assembled: string) => Promise<string>
  readonly fade?: number
}

/**
 * Render the segments one after the other, each with its own seed — the same
 * seed would render the same seconds over and over — and join them.
 * @param run - the run's render hooks.
 * @param segments - what each segment renders and how the join is made.
 * @returns the joined file.
 */
async function renderSegments(run: RenderRun, segments: Segments): Promise<readonly ComfyProducedFile[]> {
  const parts: string[] = []
  const lengths: number[] = []
  for (let index = 0; index < segments.count; index += 1) {
    const over = await segments.over(index)
    const produced = await run.render(undefined, nextSeed(run.seed, index), over)
    const clip = produced.files.find(file => file.kind === 'video')
    if (clip === undefined) throw new Error(segments.missing)
    if (segments.scratch === true) run.state.scratch.push(clip.path)
    parts.push(clip.path)
    lengths.push(segments.length(index))
    if (segments.freeBetween === true && index < segments.count - 1) {
      await run.ctx.comfy.freeMemory(run.signal).catch(() => undefined)
    }
  }
  return run.assemble(parts, lengths, segments.errors, segments.finish, segments.fade)
}

/**
 * An animated background is a chain, not one render: the model's ceiling
 * is ten seconds and the card offers up to a minute. Every segment is
 * given the still as its first and last frame, so each one leaves the
 * photo and comes back towards it, the segments are dissolved into one
 * another at the joins, and the finished file is closed into a loop so it
 * begins where it ends.
 */
async function renderLoop(run: RenderRun): Promise<readonly ComfyProducedFile[]> {
  const { workflow, outputDir } = run
  const job = run.state.job
  // A graph that closes the loop by itself returns length − 5 frames and does
  // not want the tail crossfaded over the head: it would redo the joint the
  // sampler has just denoised.
  const closed = closesItsOwnLoop(workflow)
  /*
   * A chained background (past six seconds, the Context Loop graph) is ONE
   * run: the graph renders its scenes, the last one landing back on the
   * still, and the file is then closed like any other.
   */
  const chained = workflow.planJson !== undefined
  const seconds = chained ? [job.seconds ?? MAX_SHOT_SECONDS] : loopSegments(job.seconds ?? MAX_SHOT_SECONDS)
  /*
   * Dissolved, not butted: a segment ends wherever the model took it —
   * measured 12.1 from the still on a 20-second background whose normal
   * frame step is 0.5 — and the next opens on the still, so a hard join
   * is the one place a viewer sees a jump. The dissolve spreads it over
   * half a second.
   *
   * Then the file is closed into a loop: the model does not land back on
   * the still (12.5 between the last frame and the first, measured), so the
   * tail is dissolved over the head and the file ends one frame before that
   * dissolve begins — 2.7 on the same measurement, which is one frame of
   * its own motion.
   */
  return renderSegments(run, {
    count: seconds.length,
    over: async index => ({
      path: declaredOutputPath(outputDir, 'animated_background_part', 'mp4', { id: job.id, index }),
      seconds: seconds[index] ?? MAX_SHOT_SECONDS,
    }),
    // What the sampler really made of the segment: the dissolve is sized
    // and placed on the rendered length, not on the seconds it was asked
    // for (a ten-second shot is 10.125 s).
    length: (index) => {
      const asked = seconds[index] ?? MAX_SHOT_SECONDS
      if (chained) return asked
      return closed ? renderedSeconds(asked) - LOOP_CLOSED_TAIL_FRAMES / FPS : renderedSeconds(asked)
    },
    missing: message('job.backgroundSegmentEmpty'),
    errors: {
      none: message('job.backgroundNoSegments'),
      unmeasured: message('job.backgroundSizeUnreadable'),
    },
    finish: async (assembled) => {
      if (closed && seconds.length === 1) return assembled
      return closeLoop(assembled, (await probeMedia(assembled)).duration, outputDir)
    },
  })
}

/**
 * «Regenerate detail»: the clip is redone in 124-frame windows.
 *
 * The refiner on the 5070 Ti holds 124 frames at ~2.1 MP (135 s per pass,
 * 13.9 GB peak) and goes OOM at 2K: a longer clip is not a single pass. The
 * windows step by 100 frames, i.e. 24 of overlap, which is exactly the one
 * second of crossfade `joinCuts` joins them with; the frames the last one is
 * missing are cloned (`tpad=stop_mode=clone` in regenerateDraft), and the
 * extra tail drops when the original audio goes back on the file with
 * `-shortest`. The finished file takes the name the job declared; the pieces
 * are dot-prefixed and invisible to the gallery.
 */
async function renderRegenerate(run: RenderRun): Promise<readonly ComfyProducedFile[]> {
  const { state, outputDir } = run
  const job = state.job
  const plate = run.inputs.sourceVideo
  if (plate === undefined) throw new Error(message('job.regenerateVideoRequired'))
  const probe = await probeMedia(plate)
  /*
   * Frames count in the refiner's timeline (24 fps), not the file's: a 30 fps
   * clip read by its own frames would plan windows longer than the clip.
   */
  const frames = probe.duration > 0
    ? Math.round(probe.duration * FPS)
    : probe.frames ?? REGENERATE_WINDOW_FRAMES
  const starts = regenerateStarts(frames)
  return renderSegments(run, {
    count: starts.length,
    over: async (index) => {
      const draft = await regenerateDraft(plate, starts[index] ?? 0, probe)
      state.scratch.push(draft)
      return {
        // Dot-prefixed: the gallery does not list intermediates (see listGallery).
        path: join(outputDir, `.regenerate-${job.id}-${String(index)}.mp4`),
        video: await resolveInputVideo({ path: draft }, outputDir),
      }
    },
    // The delivered length is the draft's (124 frames): the joint crossfades
    // the overlap and the timeline stays the clip's.
    length: () => REGENERATE_WINDOW_FRAMES / FPS,
    missing: message('job.regenerateWindowEmpty'),
    errors: {
      none: message('job.regenerateNoWindows'),
      unmeasured: message('job.regenerateSizeUnreadable'),
    },
    scratch: true,
    /*
     * Every window needs the same models: the card must be freed between one
     * and the next, or the second finds the memory already taken by the first
     * (measured on the old windowed object swap, which chained the same way).
     */
    freeBetween: true,
    finish: async assembled => layPlateAudio(assembled, plate, outputDir, 'regenerate-audio'),
    fade: REGENERATE_FADE_SECONDS,
  })
}

/**
 * An object swap: one prompt for the whole clip. Every shipped swap graph
 * plans, renders and joins its own clips and lays the plate's soundtrack
 * back (a loop start, `loopsItsOwnWindows`); a custom graph without one gets
 * the same single render of the whole plate.
 */
async function renderSwap(run: RenderRun): Promise<readonly ComfyProducedFile[]> {
  return renderRelay({
    outputDir: run.outputDir,
    job: run.state.job,
    seed: run.seed,
    render: run.render,
  })
}

/** The renderer of each action that is more than one render; the rest render once. */
const RENDERERS: Partial<Record<ImagineAction, (run: RenderRun) => Promise<readonly ComfyProducedFile[]>>> = {
  loop: renderLoop,
  objectSwap: renderSwap,
  regenerate: renderRegenerate,
}

/**
 * A shot whose chain broke was rendered with its context: its head comes
 * off here, so the cut keeps its timeline.
 */
async function trimHead(files: readonly ComfyProducedFile[], outputDir: string): Promise<void> {
  const mine = files.find(file => file.kind === 'video')
  if (mine === undefined) return
  try {
    const trimmed = await dropHead(mine.path, outputDir)
    await renameWithRetry(trimmed, mine.path)
  } catch {
    // Left untrimmed: the video runs GUIDE_SECONDS long from here on,
    // which is a worse cut than a lost shot would have been a hole.
  }
}

/**
 * Render the job — once, or as a chain of segments — with
 * the retries a chained or sung shot is allowed, and hand the result on.
 */
async function renderAndFinish(
  ctx: ImagineHost,
  state: RunState,
  workflow: LoadedWorkflow,
  workflows: ImagineWorkflows,
  outputDir: string,
  inputs: RunInputs,
  audio: RunAudio,
  pixelsOf: PixelsOf,
  controller: AbortController,
): Promise<void> {
  const job = state.job
  const { sourceKind } = inputs
  const out = outputOf(job, workflow, sourceKind)
  const shot = deliveredShotOf(job)
  const shotPath = shot === undefined
    ? undefined
    : join(outputDir, shotFileName(storyLabel(shot.storyId), shot.index, shot.count, job.redo?.version))
  /*
   * The canvas follows the photo. `runs.output` is what the action produces,
   * so the notice is only for a clip: an image edit that keeps the photo's
   * ratio is not news.
   */
  const aspect = await aspectForImage(ctx, workflow, job.aspectRatio, inputs.imageRatio)
  if (aspect.mismatched && out.output === 'video') setJobNotice(job.id, 'video-ratio')
  const customFiles = await customFilesOf(job, outputDir)
  const { resolutionMax } = inputs
  const args = {
    prompt: state.prompt,
    seed: nextSeed(Date.now()),
    ...resolutionMax === undefined ? {} : { resolutionMax },
    ...job.source === undefined ? {} : sourceKind === 'video'
      ? { video: { path: job.source } }
      : { image: { path: job.source } },
  }
  const assemble = assemblerFor(outputDir, out, args)
  const render = rendererFor({
    ctx, state, workflow, outputDir, inputs, audio, out, args, aspect: aspect.aspect, shotPath, customFiles,
    signal: controller.signal,
  })
  const renderer = RENDERERS[job.action]
  let files: readonly ComfyProducedFile[]
  try {
    files = renderer === undefined
      ? (await render(job.chain, args.seed)).files
      : await renderer({
        ctx, state, workflow, outputDir, inputs, seed: args.seed, signal: controller.signal, render, assemble,
      })
  } catch (error: unknown) {
    files = await retryChainedShot(state, render, args.seed, controller.signal, error)
  }
  if (state.headless) await trimHead(files, outputDir)
  const sung = await retakeOffVoice(state, workflow, audio, render, args.seed, controller.signal, files)
  // The song's probe, read at most once: the cut and the song laid over it
  // both want its length.
  let songTrack: Promise<MediaProbe> | undefined
  await finishRun({
    ctx,
    workflows,
    outputDir,
    job,
    files: sung.files,
    sourceKind,
    sourceVideo: inputs.sourceVideo,
    tool: out.tool,
    args,
    extendDuration: inputs.extendSource?.duration,
    ...inputs.extendSource?.pixels === undefined ? {} : { extendPixels: inputs.extendSource.pixels },
    // A chained continuation comes back with the clip already in front of it.
    wholeClip: job.action === 'extend' && workflow.planJson !== undefined,
    shot,
    writtenPrompt: state.writtenPrompt,
    lipsync: sung.lipsync,
    pixelsOf,
    songTrack: () => (songTrack ??= probeMedia(join(outputDir, job.song ?? ''))),
  })
}

/**
 * A chained shot is given a second chance before it takes the video down.
 *
 * The card is not the only thing that fails: one shot of a chain came out NaN
 * from its first step with clean inputs (the previous latent checked, the
 * same settings as the two shots before it) — a numerical accident, and a new
 * seed is the cure. Out of memory skips that and goes straight to a fresh
 * start, which carries less; anything that still fails fresh is a real
 * failure.
 * @returns the files of the take that rendered; throws what cannot be retried.
 */
async function retryChainedShot(
  state: RunState,
  render: Render,
  seed: number,
  signal: AbortSignal,
  error: unknown,
): Promise<readonly ComfyProducedFile[]> {
  const job = state.job
  const chain = job.chain
  if (job.cut !== true || chain === undefined || chain.fresh === true || signal.aborted) throw error
  /*
   * The server, not the shot. A run that ran out its deadline or never
   * got an answer says nothing about this clip: a new seed and a fresh
   * start ask the same unanswering server the same question twice more,
   * and the shot is then written off as one the card refused — a hole in
   * the video, filed under the wrong cause. Measured on 2026-09-09: a
   * wedged ComfyUI took five shots of a music video that way, each
   * burning its ladder against a server executing nothing. Let it fail as
   * what it is, and the cut queues it again.
   *
   * The same goes for a graph that refused its parameters (`COMFY_GRAPH_
   * REJECTED`): the frame a plan node will not take is the same frame with
   * any seed, so a second render only shows the user the same error again.
   */
  if (error instanceof ComfyError
    && (error.code === 'COMFY_TIMEOUT' || error.code === 'COMFY_UNREACHABLE' || error.code === 'COMFY_GRAPH_REJECTED')) {
    throw error
  }
  const oom = error instanceof ComfyError && error.code === 'COMFY_OUT_OF_MEMORY'
  try {
    if (oom) throw error
    return (await render(chain, nextSeed(seed, 0, 1))).files
  } catch {
    // A cancel in between surfaces from the fresh render itself, which
    // throws at once on an aborted signal.
    state.headless = true
    setJobNotice(job.id, 'chain-broken')
    return (await render({ ...chain, fresh: true }, nextSeed(seed, 0, 2))).files
  }
}

/**
 * Was the mouth on the voice? A sung shot is measured as soon as it is
 * rendered — mouth aperture against the vocal's loudness — and one that
 * scores under the floor is rendered again with a new seed, and again for as
 * many retries as the deployment allows. The last render is the one delivered
 * whatever it scores: its latent is the one in the chain's slot, so the shot
 * after it continues from the clip that is there. Measured 2026-09-10:
 * 0.19-0.20 on shots whose lips ran a second off the voice, 0.47-0.54 on
 * shots in time. A shot whose chain broke is measured but not retried — its
 * second render would have to break the chain again. No probe, or a probe
 * that fails, means no score and the shot is taken as it is.
 * @returns the take delivered and its score.
 */
async function retakeOffVoice(
  state: RunState,
  workflow: LoadedWorkflow,
  audio: RunAudio,
  render: Render,
  seed: number,
  signal: AbortSignal,
  rendered: readonly ComfyProducedFile[],
): Promise<{ files: readonly ComfyProducedFile[]; lipsync?: number }> {
  const job = state.job
  const check = workflow.lipsync
  const voiceFile = audio.voiceFile
  if (check === undefined || job.cut !== true || job.sings === undefined || !audio.sings || audio.silentSlice
    || voiceFile === undefined) {
    return { files: rendered }
  }
  let files = rendered
  const floor = check.min ?? LIPSYNC_MIN
  const offset = voiceOffsetOf(job)
  const measure = async (): Promise<LipsyncProbe | undefined> => {
    const clip = files.find(file => file.kind === 'video')
    return clip === undefined ? undefined : await lipsyncScore(check.probe, clip.path, voiceFile, offset)
  }
  let probe = await measure()
  const retries = state.headless ? 0 : check.retries ?? 1
  for (let attempt = 1; attempt <= retries && worthRetrying(probe, floor); attempt += 1) {
    if (signal.aborted) break
    setJobNotice(job.id, 'lipsync-retry')
    console.warn(`[imagine] lipsync: ${basename(files.find(file => file.kind === 'video')?.path ?? '')} `
      + `corr0 ${probe?.corr0 ?? 'none'} bestLag ${probe?.bestLag ?? 'none'} `
      + `movement ${probe?.movCorr0 ?? 'none'}, rendering the shot again (${String(attempt)}/${String(retries)})`)
    try {
      files = (await render(job.chain, nextSeed(seed, attempt))).files
    } catch {
      // The second render failing says nothing about the first, which is
      // still on disk and in the chain's slot: keep it.
      break
    }
    probe = await measure()
  }
  return probe === undefined ? { files } : { files, lipsync: probe.corr0 }
}
