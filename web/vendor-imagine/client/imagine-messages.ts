/**
 * What the studio says, worked out from what happened: the sentence for a
 * failure, a finished or failed run, a job notice and a reading step. Pure
 * functions over the dictionary, split out of ImaginePage.tsx (2026-10-25);
 * the ones that used to be chains of `if` are tables.
 * @module imagine-messages
 */

import { messageOf } from './message-of.ts'
import type { GalleryItem, ImagineJobView as ImagineJob } from '../../../shared/imagine-types.ts'
import type { ImagineChatEvent } from '../../../shared/imagine-chat.ts'
import { refusedInputs } from './comfy-errors.ts'
import type { ImagineMode } from './imagine-settings.ts'
import type { ComfyLocaleKey } from './locales.ts'
import type { ImagineThought } from './reading-trace.ts'
import { translate } from './locale-store.ts'

/** Tools whose files take minutes each on the GPU. */
const SLOW_TOOLS: ReadonlySet<string> = new Set([
  'create_video', 'upscale_video', 'extend_video', 'animated_background', 'videoclip',
  'recreate_video', 'object_swap',
])

/**
 * Longest gap between two files of one run on the board, by the kind of file.
 *
 * Files are grouped by when they finished: a finished job leaves the queue,
 * so when it was queued is not known any more. Photos come out seconds apart;
 * three videos asked in one line come out one after the other, four minutes
 * each, and with the photos' three minutes every clip opened a row of its own
 * — a column of single videos beside a row of photos (2026-10-19).
 * @param kind - the tool that made the file, or its media kind.
 * @returns the gap in milliseconds.
 */
export function runGapOf(kind: string): number {
  return SLOW_TOOLS.has(kind) ? 600_000 : 180_000
}

/**
 * Minutes of card time one clip of a long video costs, for the note that says
 * how long the chain will take. Measured on this deployment: a five-second
 * continuation takes about five minutes, a ten-second one about eight.
 */
export const STORY_MINUTES_PER_CLIP = 8

/**
 * Say which input ComfyUI refused, when that is why the run failed.
 * @param raw - the error text the run failed with.
 * @returns the sentence, or undefined when this is not a node rejection.
 */
function refusedNote(raw: string): string | undefined {
  const refused = refusedInputs(raw)
  if (refused.length === 0) return undefined
  // Two is what fits a chat bubble; a graph that refuses more than that is
  // wrong in a way one sentence was never going to explain.
  return refused.slice(0, 2)
    .map(entry => entry.notInList && entry.value !== undefined
      ? translate('imagine.errNotInList', { node: entry.node, class: entry.kind, field: entry.field, value: entry.value })
      : translate('imagine.errRefused', { node: entry.node, class: entry.kind, field: entry.field, reason: entry.reason }))
    .join(' ')
}

/** Extract a user-friendly message from a ComfyUI or internal error string. */
function friendlyError(raw: string): string {
  // A dropped connection surfaces as the browser's own untranslated sentence,
  // which names neither what failed nor what to do about it.
  if (raw.includes('Failed to fetch') || raw.includes('NetworkError') || raw.includes('Load failed')) {
    return translate('imagine.errOffline')
  }
  // The refused input names what to write instead; the generic sentence below
  // says only that something failed, which is what the chat could not explain.
  const refused = refusedNote(raw)
  if (refused !== undefined) return refused
  if (raw.includes('prompt_outputs_failed_validation')) return translate('imagine.errValidation')
  if (raw.includes('Invalid image file')) return translate('imagine.errBadImage')
  if (raw.includes('Custom validation failed')) {
    const match = /"details":"([^"]+)"/.exec(raw)
    if (match?.[1] !== undefined) return match[1]
    return translate('imagine.errBadInput')
  }
  if (raw.includes('tempo massimo')) return raw
  const stripped = raw.replace(/^ComfyUI rejected the workflow:\s*/, '')
  if (stripped.length > 150) return stripped.slice(0, 147) + '…'
  return stripped || raw
}

/**
 * The composer note for a rejected call. Every failure the user reads goes
 * through friendlyError: a start that ComfyUI refused used to put the server's
 * JSON under the prompt, and an unreachable host put the browser's own English
 * there.
 * @param error - whatever the failed call threw.
 * @returns a sentence for the composer.
 */
export function noteFromError(error: unknown): string {
  return friendlyError(messageOf(error))
}

/** The line for each notice the host sets on a job. */
const NOTICE_KEYS: Readonly<Record<string, ComfyLocaleKey>> = {
  'comfy-restart': 'imagine.noticeComfyRestart',
  'song-failed': 'imagine.noticeSongFailed',
  'montage-failed': 'imagine.noticeMontageFailed',
  'montage-repairing': 'imagine.noticeMontageRepairing',
  'lipsync-retry': 'imagine.noticeLipsyncRetry',
  'caption-plain': 'imagine.noticeCaptionPlain',
  'video-ratio': 'imagine.noticeVideoRatio',
  'voice-mux-failed': 'imagine.noticeVoiceMuxFailed',
  'recreate-audio-failed': 'imagine.noticeRecreateAudioFailed',
  'setup-needed': 'imagine.noticeSetupNeeded',
  'setup-running': 'imagine.noticeSetupRunning',
}

/**
 * Say one job notice in the user's language.
 *
 * The host names what happened and never writes it. An unknown key is shown as
 * it came: a notice this build does not know is still a fact about the run, and
 * the key names it better than silence does.
 * @param key - the notice the host set on the job.
 * @returns the line for the column.
 */
export function noticeText(key: string): string {
  const line = NOTICE_KEYS[key]
  return line === undefined ? key : translate(line)
}

/**
 * What did not happen, by the run's action.
 *
 * A failure used to reach the chat as the reason alone — "workflow has no
 * LoadVideo node for the input video" under a request for a song. Nothing on
 * screen said which of the runs in flight it belonged to, and the studio's own
 * reader, which is given these lines and nothing else, answered the next
 * question by inventing one: it reported a video workflow failing and the song
 * safely queued, when the song was exactly what had failed (2026-09-09).
 */
const FAILED_KEYS: Partial<Record<ImagineJob['action'], ComfyLocaleKey>> = {
  music: 'imagine.failedMusic',
  loop: 'imagine.failedLoop',
  video: 'imagine.failedVideo',
  story: 'imagine.failedVideo',
  redo: 'imagine.failedVideo',
  resume: 'imagine.failedVideo',
  extend: 'imagine.failedExtend',
  generate: 'imagine.failedGenerate',
  remix: 'imagine.failedRemix',
  upscale: 'imagine.failedUpscale',
  bg: 'imagine.failedBg',
  voice: 'imagine.failedVoice',
  objectSwap: 'imagine.failedObjectSwap',
  swapPerson: 'imagine.failedSwapPerson',
  relight: 'imagine.failedRelight',
  speak: 'imagine.failedSpeak',
}

/**
 * The sentence for a finished run, by its action: one file, then several.
 *
 * One file gets its own sentence rather than a number and a slashed suffix:
 * "I generated 1 image(s)." was what every successful run said, and one file
 * is what almost every run produces. Every action used to fall through to
 * "I generated one image.": a clip, a continued clip and a spoken line all
 * came back announced as a picture, and that line became the project's title
 * ("Freshly generated image") (2026-10-17). The scan half of "Recreate video"
 * draws the frames and stops: its line says that the recreation has NOT
 * happened yet, or the frames under a sentence about a video read as the
 * video having gone missing.
 */
const DONE_KEYS: Partial<Record<ImagineJob['action'], readonly [one: ComfyLocaleKey, many: ComfyLocaleKey]>> = {
  video: ['imagine.doneVideoOne', 'imagine.doneVideo'],
  story: ['imagine.doneVideoOne', 'imagine.doneVideo'],
  redo: ['imagine.doneVideoOne', 'imagine.doneVideo'],
  resume: ['imagine.doneVideoOne', 'imagine.doneVideo'],
  loop: ['imagine.doneLoopOne', 'imagine.doneLoop'],
  remix: ['imagine.doneRemixOne', 'imagine.doneRemix'],
  upscale: ['imagine.doneUpscaleOne', 'imagine.doneUpscale'],
  bg: ['imagine.doneBgOne', 'imagine.doneBg'],
  music: ['imagine.doneMusicOne', 'imagine.doneMusic'],
  objectSwap: ['imagine.doneObjectSwapOne', 'imagine.doneObjectSwap'],
  swapPerson: ['imagine.doneSwapPersonOne', 'imagine.doneSwapPerson'],
  relight: ['imagine.doneRelightOne', 'imagine.doneRelight'],
  scanFrame: ['imagine.doneScanFrameOne', 'imagine.doneScanFrame'],
  extend: ['imagine.doneExtendOne', 'imagine.doneVideo'],
  speak: ['imagine.doneSpeakOne', 'imagine.doneSpeak'],
}

/**
 * The status line a settled job leaves in its project's column.
 * @param job - the job, done, failed or cancelled.
 * @returns the line.
 */
export function jobDoneText(job: ImagineJob): string {
  if (job.status === 'cancelled') return translate('imagine.jobCancelled')
  if (job.status === 'error') {
    return translate('imagine.failedWith', {
      what: translate(FAILED_KEYS[job.action] ?? 'imagine.failedRun'),
      reason: job.error !== undefined ? friendlyError(job.error) : translate('imagine.jobError'),
    })
  }
  const files = job.files ?? []
  const clip = files.some(file => file.kind === 'video')
  /*
   * A voice change on a clip comes back as a clip: the line says what landed
   * on the board, and "I changed the voice of the track" under a video reads
   * as the wrong half of the job.
   */
  const keys = job.action === 'voice'
    ? clip ? ['imagine.doneVoiceClipOne', 'imagine.doneVoiceClip'] as const : ['imagine.doneVoiceOne', 'imagine.doneVoice'] as const
    : DONE_KEYS[job.action] ?? (clip ? DONE_KEYS.video : undefined) ?? ['imagine.doneGenerateOne', 'imagine.doneGenerate'] as const
  return files.length === 1 ? translate(keys[0]) : translate(keys[1], { count: String(files.length) })
}

let lastThoughtId = 0
/** A fresh id for a line of the trace. */
export function nextThoughtId(): number {
  lastThoughtId += 1
  return lastThoughtId
}

/**
 * Say one step of a reading in the user's language.
 *
 * The host names its steps and never writes them: the wording is the client's,
 * the way job notices already are.
 * @param event - the step the host reported.
 * @returns the line for the column, or undefined for a step with nothing to say.
 */
export function thoughtOf(event: ImagineChatEvent): ImagineThought | undefined {
  if (event.kind === 'reasoning') return undefined
  const step = (text: string, keep = false): ImagineThought => ({ id: nextThoughtId(), kind: 'step', text, keep })
  switch (event.step) {
    case 'sight': return step(translate('imagine.thoughtSight', { count: String(event.count ?? 1) }))
    case 'route': return step(translate('imagine.thoughtRoute', { model: event.detail ?? '' }))
    case 'retry': return step(translate('imagine.thoughtRetry', { model: event.detail ?? '' }), true)
    case 'writing': return step(translate('imagine.thoughtWriting'))
    case 'workflow': return step(translate('imagine.thoughtWorkflow', { name: event.detail ?? '' }))
    case 'fallback': return step(translate('imagine.thoughtFallback'), true)
    default: return undefined
  }
}

/**
 * A file kind's composer mode: the mode a picked or dropped file puts the
 * composer in.
 * @param kind - the file's kind.
 * @returns the plain mode for it.
 */
export function modeForKind(kind: GalleryItem['kind']): ImagineMode {
  return kind === 'video' ? 'video' : kind === 'audio' ? 'music' : 'image'
}

/**
 * A fingerprint of the job queue: what a board lays out from it. The progress
 * (percentage, step, preview frame) is not part of it: it goes to
 * `job-progress`, read only by what draws it, so a tick that moves a
 * percentage sets nothing in the page.
 * @param jobs - the queue as read.
 * @returns a string that changes when anything the page reads of the queue does.
 */
export function jobsFingerprint(jobs: readonly ImagineJob[]): string {
  return jobs.map(job => [
    job.id, job.status,
    job.files?.map(file => file.name).join(','), job.notice, job.error, job.writtenPrompt?.length,
    job.storyCount,
  ].join(':')).join('|')
}
