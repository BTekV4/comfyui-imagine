/**
 * What the studio says, worked out from what happened: the sentence for a
 * failure, a finished or failed run, a job notice and a reading step. Pure
 * functions over the dictionary, split out of ImaginePage.tsx (2026-10-25);
 * the ones that used to be chains of `if` are tables.
 * @module imagine-messages
 */

import { messageOf } from './message-of.ts'
import type { GalleryItem, GalleryTool, ImagineJobView as ImagineJob } from '../../../shared/imagine-types.ts'
import { ACTION_TRAITS } from './action-traits.ts'
import type { ImagineChatEvent } from '../../../shared/imagine-chat.ts'
import { refusedInputs } from './comfy-errors.ts'
import type { ImagineMode } from './imagine-settings.ts'
import type { ComfyLocaleKey } from './locales.ts'
import type { ImagineThought } from './reading-trace.ts'
import { translate } from './locale-store.ts'

/**
 * Whether each host tool's files take minutes each on the GPU.
 *
 * Typed over every `GalleryTool`, so a new tool has to say which it is: the
 * hand-kept set this replaced (2026-11-15) had missed `regenerate_detail` and
 * `swap_person`, whose clips then got the photos' short gap and opened a row
 * each — the very split `runGapOf` is there to prevent.
 */
const SLOW_TOOLS: Readonly<Record<GalleryTool, boolean>> = {
  generate_image: false,
  generate_lookbook: false,
  edit_image: false,
  add_audio: false,
  remove_background: false,
  relight: false,
  upscale_image: false,
  generate_music: false,
  change_voice: false,
  speak_text: false,
  create_video: true,
  extend_video: true,
  recreate_video: true,
  regenerate_detail: true,
  object_swap: true,
  swap_person: true,
  animated_background: true,
  upscale_video: true,
  videoclip: true,
}

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
  // A clip with no tool on record (written before the host read the prefix)
  // is still a clip: it is keyed by its media kind, `video`.
  const slow = kind === 'video' || (Object.hasOwn(SLOW_TOOLS, kind) && SLOW_TOOLS[kind as GalleryTool])
  return slow ? 600_000 : 180_000
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
  /*
   * A graph that refuses its frame is a deterministic failure, not something
   * another try can fix: the host does not retry it either. The node's own
   * sentence names the grid, which means nothing to the person reading it.
   */
  if (/must be (a )?(positive )?multiples? of 32/i.test(raw)) return translate('imagine.errFrameGrid')
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
  'separating-voice': 'imagine.noticeSeparatingVoice',
  'song-failed': 'imagine.noticeSongFailed',
  'montage-failed': 'imagine.noticeMontageFailed',
  'montage-repairing': 'imagine.noticeMontageRepairing',
  'lipsync-retry': 'imagine.noticeLipsyncRetry',
  'caption-plain': 'imagine.noticeCaptionPlain',
  'video-ratio': 'imagine.noticeVideoRatio',
  'edit-unchanged': 'imagine.noticeEditUnchanged',
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
 * The status line a settled job leaves in its project's column. The word for
 * each action's failure and its sentence for a finished run are in the action
 * table (`failedKey`, `doneKeys` in action-traits.ts).
 * @param job - the job, done, failed or cancelled.
 * @returns the line.
 */
export function jobDoneText(job: ImagineJob): string {
  if (job.status === 'cancelled') return translate('imagine.jobCancelled')
  if (job.status === 'error') {
    return translate('imagine.failedWith', {
      // `?.`: a job record from another host version may name an action this page lacks.
      what: translate(ACTION_TRAITS[job.action]?.failedKey ?? 'imagine.failedRun'),
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
    : ACTION_TRAITS[job.action]?.doneKeys ?? (clip ? ACTION_TRAITS.video.doneKeys : undefined) ?? ['imagine.doneGenerateOne', 'imagine.doneGenerate'] as const
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
    case 'grounding': return step(translate('imagine.thoughtGrounding', { target: event.detail ?? '' }))
    case 'route': return step(translate('imagine.thoughtRoute', { model: event.detail ?? '' }))
    case 'retry': return step(translate('imagine.thoughtRetry', { model: event.detail ?? '' }), true)
    case 'writing': return step(translate('imagine.thoughtWriting'))
    case 'workflow': return step(translate('imagine.thoughtWorkflow', { name: event.detail ?? '' }))
    case 'fallback': return step(translate('imagine.thoughtFallback'), true)
    /*
     * The agent's steps. The tool line keeps its text after the turn: it is
     * the prompt actually sent, which is how a rewrite by the model is seen
     * rather than discovered in the result.
     */
    case 'tool': return step(translate('imagine.thoughtTool', { name: event.name ?? '', detail: event.detail ?? '' }), true)
    case 'queued': return step(translate('imagine.thoughtQueued', { action: event.detail ?? '' }))
    case 'waiting': return step(translate('imagine.thoughtWaiting', { percent: event.percent === undefined ? '…' : `${String(event.percent)}%` }))
    case 'looked': return step(translate('imagine.thoughtLooked', { file: event.detail ?? '' }))
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
