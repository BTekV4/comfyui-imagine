/**
 * The in-memory map of Imagine jobs: what a job is, how it is written and
 * read, when it counts as settled, how it is stopped and pruned. Nothing here
 * runs a graph: the runner (`run-job.ts`) and the starters write through these
 * functions, and the routes read through them.
 * @module tool-comfy/job-queue
 */

import type { ImagineHost } from '../../src/host.ts'
import type { ComfyChainLink } from './index.ts'
import type { Singer } from './music-prompt.ts'
import type {
  ImagineJobFields, ImagineQuality, ImagineRegion, ImagineSpeed, ModelRoute, ImagineSetupPlan,
} from '../../../shared/imagine-types.ts'
import { message } from '../../src/messages.ts'

/**
 * Where a `speak` job reads its text out loud: an OpenAI-shaped speech
 * endpoint that answers with the audio bytes themselves.
 */
export interface SpeakTarget {
  readonly baseURL: string
  readonly model: string
  readonly voice: string
  /** The container the service is asked for; the service rejects what it cannot encode. */
  readonly format: string
  /**
   * The ASR model a `voice` job transcribes the track with.
   *
   * Absent, the deployment's default Whisper (`whisper-large-v3-turbo`).
   */
  readonly asrModel?: string
  /**
   * `tts` when the `voice` action itself goes through this service —
   * transcribe the track, read it back out — instead of the ComfyUI RVC graph.
   * Absent (or `rvc`), the graph stays the voice changer.
   */
  readonly voiceChange?: 'tts' | 'rvc'
}

/**
 * One in-flight or finished Imagine job: the fields the page reads
 * ({@link ImagineJobFields}, shared) and the ones only the runner uses.
 */
export interface ImagineJob extends ImagineJobFields {
  /** The RVC voice a `voice` job sings its source with. */
  readonly voice?: string
  /** Semitones the voice is shifted by; negative goes down. */
  readonly pitch?: number
  /**
   * The second photo: the object of an `objectSwap`, the reference of a
   * `compose`.
   *
   * The clip or photo being modified is the job's `source`; this one is read
   * the way an ordinary input image is and uploaded beside it.
   */
  readonly reference?: string
  /**
   * The opening frame a `recreate` renders from, once the run drew it.
   *
   * Kept on the job because the render is written from the same picture: the
   * prompt pass reads this file, not the reference clip, and a retry has it
   * already.
   */
  readonly frame?: string
  /**
   * How many candidate frames a `scanFrame` was asked for.
   *
   * On the job and not in the runner's scope: the count is chosen when the job
   * is queued and read minutes later, when the scan reaches the drawing.
   * Absent, the scan draws `SCAN_FRAMES`.
   */
  readonly candidates?: number
  /**
   * Whether a `recreate` keeps the reference clip's own soundtrack.
   *
   * True, the finished video carries the track that was filmed; false or
   * absent, it carries the audio the video model wrote under the new picture.
   */
  readonly keepAudio?: boolean
  /** A character swap without lip-sync: the new people do not mouth the clip's vocals. */
  readonly lipSync?: boolean
  /** The resolution label an Openjutsu plan renders at, when not the graph's own (480p on the lower step). */
  readonly planResolution?: string
  /** The short side an upscale was asked to arrive at. */
  readonly upscaleTo?: number
  /** `custom` only: the card's file slots, keyed by node id (gallery basenames). */
  readonly customFiles?: Readonly<Record<string, string>>
  /**
   * How the clip is rendered: `fast`, the graph the entry ships, or `slow`,
   * the entry's second graph (`pathHigh`) when it declares one, else the
   * same graph with its `highInputs` and `steps.high`. The graph is chosen
   * before the job is queued (`readJobRequest`); the runner only passes the
   * value on, for the overrides and the step count. The queue lives in memory only, so no job outlives a restart
   * and no older spelling of this field has to be read.
   */
  readonly speed?: ImagineSpeed
  /**
   * How a photo is drawn: `standard`, the graph's own step count, or `high`,
   * the workflow's `steps.high` (sixteen on the Krea 2 graphs).
   */
  readonly quality?: ImagineQuality
  /**
   * The zone a `remix` is confined to, as fractions of the photo (0–1). The
   * rest of the photo comes back as the source's own pixels.
   */
  readonly region?: ImagineRegion
  /** A zone edit whose zone was painted: the mask waits in {@link keepPaintedMask}. */
  readonly painted?: boolean
  /** What the tracker looks for in the clip; an `objectSwap` job. */
  readonly subjectText?: string
  /** What the photo shows, as the graph's reference document; an `objectSwap` job. */
  readonly referenceText?: string
  /**
   * The job whose produced file is this job's source.
   *
   * A story's clips are queued before any of them has run, so the second one
   * cannot name the file it continues: it names the job that will make it, and
   * the source is read off that job the moment its own turn comes.
   */
  readonly follows?: string
  /**
   * A track this clip must sing: anchored as its audio guide, so the video is
   * generated listening to it. Set on every shot of a video cut to a song,
   * while `song` sits on the last one and is laid over the finished cut.
   */
  readonly sings?: string
  /** Where this clip starts in that track, in seconds. */
  readonly songStart?: number
  /**
   * This shot continues the one before it through the model's own latent.
   *
   * The song workflow's H3 Motion Context nodes pin the previous shot's last
   * frames at the head of this one and deliver it without them: the join is
   * sampled, not cut. `index` is the slot this shot continues from, so the
   * first shot of a chain reads nothing and only saves.
   */
  readonly chain?: ComfyChainLink
  /**
   * A shot rendered again into a story that already has a record: its file
   * goes into the record in place of the old one. `rebuild` false leaves the
   * video uncut — a resumed story cuts it once, after its last missing shot.
   */
  readonly redo?: { readonly storyId: string; readonly index: number; readonly version: number; readonly rebuild?: boolean }
  /**
   * This shot is a cut, not a continuation: it has its own photo.
   *
   * A montage still uses `follows` — for the order, and so that stopping one
   * shot stops the rest — but the job it follows only gates it; the source
   * stays the photo the user picked for this shot. The last shot of a montage
   * is also the one that cuts them all together.
   */
  readonly cut?: boolean
  /**
   * This montage's shots do not continue each other: no shot has an arrival
   * photo, so each clip stays in the scene its own photo shows.
   *
   * Read at render time as well as at queue time, because a shot resolves its
   * photo from the plan when its turn comes: without it here, a montage asked
   * for hard cuts would get an arrival photo back the moment it started.
   */
  readonly hardCuts?: boolean
  /**
   * The photo this shot has to arrive at.
   *
   * `MiniMaxH3ImageToVideo` takes a `last_frame`, so a montage can give shot n
   * the photo of shot n+1 and let the model invent the move between them: the
   * shot ends on exactly the frame the next one opens with, and the joined
   * video reads as one continuous take through the photos instead of a stack
   * of separate clips a dissolve is trying to hide.
   */
  readonly lastSource?: string
  /**
   * The model the studio was showing when this job was started.
   *
   * Imagine writes text before it runs a graph — the caption and the structure
   * tags of a song, the beats of a story, the rewrite of a look — and those
   * passes used to take `models.text` from the deployment's config while the
   * chip in the composer named a different model. The chip then promised a
   * choice it did not make: mimo on screen, another model writing. Carried on
   * the job so every pass runs on the model the user can see.
   */
  readonly model?: ModelRoute
  /**
   * When the job last stopped moving, for the TTL to age from.
   *
   * A montage's shots share `createdAt` — they are queued together — so aging
   * from that discards an hour-long chain the moment it ends.
   */
  readonly updatedAt?: number
  /**
   * When the run started executing, as opposed to when it was queued.
   *
   * A batch of shots is queued together and each takes its turn on the GPU:
   * aging them from `createdAt` made the last shot's "generation time" an hour
   * long. The duration filed on the produced files is measured from here.
   */
  readonly startedAt?: number
  /**
   * Which voice the music form asked to sing.
   *
   * Kept apart from `voice`, which names an RVC model for the voice changer:
   * this one only reaches the caption, and MiniMax Music knows nothing but the
   * caption.
   */
  readonly singer?: Singer
}

const jobsMap = new Map<string, ImagineJob>()

/** Told after every write to the job map, so a waiter need not poll it. */
const jobWatchers = new Set<() => void>()

/**
 * Painted masks of queued zone edits, by job id: kept out of the job itself,
 * which every poll sends back to the page. Lost on a restart, which the run
 * then says.
 */
const paintedMasks = new Map<string, Uint8Array>()

/**
 * Write one job and tell whoever is waiting on the map.
 *
 * A job that settles lets go of its painted mask: the run normally takes it
 * when it reads its inputs, but a job that fails or is stopped before that
 * point never does, and the bytes (up to 16 MB each) used to stay in the map
 * until the process restarted.
 */
export function putJob(id: string, job: ImagineJob): void {
  // A new job is the moment to age the old ones out: a deployment driven only
  // through MCP never sends the GET that used to be the only prune.
  if (!jobsMap.has(id)) pruneOldJobs()
  jobsMap.set(id, job)
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') paintedMasks.delete(id)
  for (const watcher of jobWatchers) watcher()
}

/**
 * Merge fields into a live job; a job already pruned stays gone.
 *
 * Every write a run makes goes through here, the terminal one included: the
 * run's own copy of the job is a working copy (it may render under another
 * action), and rebuilding the job from it used to drop whatever had been
 * written onto the live one mid-run — the written prompt, the tracker phrases,
 * the notice, a scan's progress.
 */
export function patchJob(id: string, fields: Partial<ImagineJob>): void {
  const live = jobsMap.get(id)
  if (live !== undefined) putJob(id, { ...live, ...fields })
}

/** Snapshot of every known Imagine job, newest first. */
export function listImagineJobs(): ImagineJob[] {
  return [...jobsMap.values()].sort((a, b) => b.createdAt - a.createdAt)
}

/** One job by id, when it exists. */
export function getImagineJob(id: string): ImagineJob | undefined {
  return jobsMap.get(id)
}

/**
 * Whether a job has stopped moving: done, failed or cancelled.
 *
 * The one test for "settled". A run reads it before writing a terminal state
 * of its own: during the run the status can only be `running`, or a terminal
 * state written from outside — the user's cancel, or the deadline's error (a
 * run only writes `error` in its own catch, so one seen before that is the
 * deadline's). A job no longer in the map is not settled.
 * @param id - the job.
 * @returns true when nobody should write a terminal state over it.
 */
export function isSettled(id: string): boolean {
  const status = jobsMap.get(id)?.status
  return status === 'done' || status === 'error' || status === 'cancelled'
}

/**
 * Wait until every one of these jobs has settled, or the time is up.
 *
 * Woken by the writes themselves: the music-video chain used to poll the map
 * on a timer for as long as its photos and its song took.
 * @param ids - the jobs to wait for.
 * @param timeoutMs - the longest wait.
 * @returns once they have all settled or the wait has run out.
 */
export async function whenJobsSettle(ids: readonly string[], timeoutMs: number): Promise<void> {
  const done = (): boolean => ids.every(isSettled)
  if (done()) return
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      jobWatchers.delete(check)
      clearTimeout(timer)
      resolve()
    }
    const check = (): void => { if (done()) finish() }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref()
    jobWatchers.add(check)
  })
}

/**
 * The finished job that produced one gallery file, when it is still known.
 *
 * A continuation reads the H3 prompt of the clip it follows off this job: the
 * two audio fields are copied forward so the soundtrack does not restart at
 * the seam, and the realism verdict is inherited rather than judged again on
 * a frame that could tip it the other way. Jobs are pruned half an hour after
 * they finish, so a clip extended much later is written from the frame alone
 * — a weaker continuation, not a failed one.
 * @param name - the source file name as the studio sent it.
 * @returns the newest job that produced it, when any.
 */
export function jobThatProduced(name: string): ImagineJob | undefined {
  let newest: ImagineJob | undefined
  for (const job of jobsMap.values()) {
    if (job.files?.some(file => file.name === name) !== true) continue
    if (newest === undefined || job.createdAt > newest.createdAt) newest = job
  }
  return newest
}

/**
 * Follow renamed shot files in the jobs still in memory, so a board folding
 * a job's files does not bring the old names back.
 * @param renames - old basename to new.
 */
export function renameJobFiles(renames: Readonly<Record<string, string>>): void {
  for (const [id, job] of jobsMap) {
    if (job.files === undefined || !job.files.some(file => renames[file.name] !== undefined)) continue
    putJob(id, { ...job, files: job.files.map(file => ({ ...file, name: renames[file.name] ?? file.name })) })
  }
}

/**
 * The abort controller of each run in flight, by job id (a speech request
 * too, which runs outside the GPU queue).
 *
 * Telling ComfyUI to drop a prompt removes it from the queue without ever
 * writing a history record, so the wait for that record cannot end on its own:
 * a cancelled job used to hold the GPU queue — and its scratch files —
 * until the run timeout expired. Aborting the wait ends the run where the user
 * ended it.
 */
const runControllers = new Map<string, AbortController>()

/** Register the run of one job, so a cancel or the deadline can abort it. */
export function startRunControl(id: string): AbortController {
  const controller = new AbortController()
  runControllers.set(id, controller)
  return controller
}

/** Forget the run of one job once it has ended. */
export function endRunControl(id: string): void {
  runControllers.delete(id)
}

/**
 * Stop a run from outside: tell ComfyUI to drop its prompt, then abort the
 * wait. The order matters — the run is not abandoned before the prompt it is
 * executing has been dropped — and a ComfyUI that cannot be reached still
 * gets the wait aborted.
 * @param ctx - plugin context carrying the `comfy` client.
 * @param id - the job.
 * @param promptId - the ComfyUI prompt it is running, when it has one yet.
 */
export async function stopRun(ctx: ImagineHost, id: string, promptId: string | undefined): Promise<void> {
  if (promptId !== undefined) await ctx.comfy.cancel(promptId).catch(() => undefined)
  runControllers.get(id)?.abort()
  setupWaits.get(id)?.no()
}

/**
 * The jobs waiting for the user's yes before ComfyUI installs what they need
 * (comfy-setup.ts), by id: the yes resolves the wait, a stop rejects it.
 */
const setupWaits = new Map<string, { readonly yes: () => void; readonly no: () => void }>()

/**
 * Show the job's install plan in the chat and wait for the user to agree.
 * @param id - the job.
 * @param plan - what ComfyUI has to install.
 * @param signal - the run's signal: a stop or the deadline ends the wait.
 * @returns when the user agreed; rejects when the job ends first.
 */
export function waitForSetupApproval(id: string, plan: ImagineSetupPlan, signal?: AbortSignal): Promise<void> {
  patchJob(id, { notice: 'setup-needed', setup: plan })
  return new Promise((resolve, reject) => {
    const finish = (): void => { setupWaits.delete(id); signal?.removeEventListener('abort', no) }
    const no = (): void => { finish(); reject(new Error(message('setup.declined'))) }
    setupWaits.set(id, {
      yes: () => { finish(); patchJob(id, { notice: 'setup-running', setupProgress: { stage: '', percent: 0 } }); resolve() },
      no,
    })
    if (signal?.aborted === true) no()
    else signal?.addEventListener('abort', no, { once: true })
  })
}

/**
 * The user's yes, from the chat.
 * @param id - the job waiting for it.
 * @returns false when no job of that id was waiting.
 */
export function approveSetup(id: string): boolean {
  const wait = setupWaits.get(id)
  if (wait === undefined) return false
  wait.yes()
  return true
}

/**
 * Where the install stands, on the job's card.
 * @param id - the job.
 * @param progress - the step, how far, how long left.
 */
export function setSetupProgress(id: string, progress: NonNullable<ImagineJob['setupProgress']>): void {
  patchJob(id, { notice: 'setup-running', setupProgress: { ...progress, percent: Math.round(progress.percent) } })
}

/**
 * The install is over and the run goes on: the card goes back to the render.
 * @param id - the job.
 */
export function endSetup(id: string): void {
  const live = getImagineJob(id)
  if (live === undefined || live.setup === undefined) return
  const { notice: _notice, setup: _setup, setupProgress: _progress, ...rest } = live
  putJob(id, rest)
}

/** Hold the painted mask a queued zone edit will read when its turn comes. */
export function keepPaintedMask(id: string, bytes: Uint8Array): void {
  paintedMasks.set(id, bytes)
}

/** The painted mask of a job, removed from memory as it is handed over. */
export function takePaintedMask(id: string): Uint8Array | undefined {
  const bytes = paintedMasks.get(id)
  paintedMasks.delete(id)
  return bytes
}

/** How long a completed job stays in the map before being pruned. */
const JOB_TTL_MS = 30 * 60 * 1000

/**
 * Remove completed or errored jobs older than JOB_TTL_MS from the in-memory
 * map. Called on the list GET and whenever a new job is put in, to keep the
 * map (and the serialized payload) from growing without bound.
 */
export function pruneOldJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS
  /*
   * Aged from when a job settled, not from when it was queued.
   *
   * Every shot of a montage carries the timestamp of the request that queued
   * them all, so an hour-long chain is already past the TTL the moment it
   * finishes: the whole video's jobs left the list within a second of the last
   * shot landing, taking the canvas tiles with them. `updatedAt` is written
   * whenever a job stops moving, so the half hour is a half hour of sitting
   * finished.
   */
  /*
   * A chain still running keeps every part it has already finished.
   *
   * The shots of a montage all carry the timestamp of the request that queued
   * them, and eleven shots take the best part of an hour: by the time the last
   * one renders, the first ten are older than the TTL and were pruned on any
   * GET — the studio polls once a second. The last shot then found nothing to
   * cut together and left eleven separate clips on the board, without even an
   * error, because a montage with no earlier shots is not a failed join.
   */
  const running = new Set<string>()
  for (const job of jobsMap.values()) {
    if (job.status !== 'queued' && job.status !== 'running') continue
    if (job.storyId !== undefined) running.add(job.storyId)
    if (job.clipId !== undefined) running.add(job.clipId)
  }
  for (const [id, job] of jobsMap) {
    if (job.status === 'queued' || job.status === 'running') continue
    if ((job.updatedAt ?? job.createdAt) >= cutoff) continue
    if (job.storyId !== undefined && running.has(job.storyId)) continue
    if (job.clipId !== undefined && running.has(job.clipId)) continue
    jobsMap.delete(id)
  }
  // A mask whose job is gone has no reader left (settling already frees the
  // mask; this catches one kept for a job that never reached the map).
  for (const id of paintedMasks.keys()) if (!jobsMap.has(id)) paintedMasks.delete(id)
}

/**
 * Stop a job the user asked to abandon.
 *
 * The GPU runs one prompt at a time, so a mistaken start used to hold the
 * queue for as long as it took to finish. The status is written before ComfyUI
 * is asked to stop, so the run's own settling — which arrives as a throw —
 * cannot overwrite it, and so the UI reflects the decision even if ComfyUI is
 * unreachable.
 * @param ctx - plugin context carrying the `comfy` client.
 * @param id - the job to stop.
 * @returns true when a live job was cancelled, false when there was none.
 */
export async function cancelImagineJob(ctx: ImagineHost, id: string): Promise<boolean> {
  paintedMasks.delete(id)
  const job = jobsMap.get(id)
  if (job === undefined || isSettled(id)) return false
  putJob(id, { ...job, status: 'cancelled', updatedAt: Date.now() })
  // A ComfyUI that cannot be reached leaves the run going, but the job is
  // already off the studio's queue and the user has their answer.
  await stopRun(ctx, id, job.promptId)
  return true
}

/**
 * Flag a live job with a one-word notice for the chat to speak once.
 * @param id - the job.
 * @param notice - the notice key, e.g. `chain-broken`.
 */
export function setJobNotice(id: string, notice: string): void {
  patchJob(id, { notice })
}

/**
 * Record the ComfyUI prompt id on a live job for progress polling.
 *
 * Uploading the input and adapting the graph take seconds, and the job is
 * already `running` throughout: a cancel decided in that window found no
 * promptId to stop, so ComfyUI carried on with a run the studio had dropped.
 * The prompt id arriving on an already-cancelled job is that race landing, and
 * it is the first moment the run can be stopped — so stop it here.
 * @param ctx - plugin context carrying the `comfy` client.
 * @param id - the job the prompt id belongs to.
 * @param promptId - the ComfyUI prompt id.
 */
export function setJobPromptId(ctx: ImagineHost, id: string, promptId: string): void {
  if (jobsMap.get(id) === undefined) return
  patchJob(id, { promptId })
  if (isSettled(id)) void stopRun(ctx, id, promptId)
}
