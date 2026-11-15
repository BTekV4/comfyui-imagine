/**
 * The Telegram notice of a scheduled post or story that ended in `error`.
 *
 * Sent through the host's `notify` (main.ts → telegram.ts), which never
 * throws: a notice is an addition to a failure that is already recorded, and
 * an unreachable Telegram must not turn a failed publication into a failed
 * scheduler tick.
 * @module social/notify
 */
import { currentLanguage, languageKind, message } from '../../../server/src/messages.ts'
import { carries, notify } from './context.ts'
import { previewOf } from './preview.ts'

/** The fields of a queue entry a notice reads. */
export interface FailedEntry {
  readonly file?: string
  readonly files?: readonly string[]
  readonly publishAt?: string
  readonly scheduledAt?: string
  readonly source?: string
  readonly error?: string
}

/**
 * Keep a long Python failure inside Telegram's 4096-character ceiling.
 *
 * The story publisher prints its whole run — config line, upload, container,
 * transcoding — before the error, so the raw text of a failure can exceed what
 * Telegram accepts; losing the whole message would defeat the notice.
 * @param text - the message body.
 * @param max - the longest acceptable body.
 * @returns the body, shortened with an ellipsis when it had to be.
 */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** The file a failed entry was to be published from. */
function failureFile(entry: FailedEntry): string {
  if (typeof entry.file === 'string' && entry.file !== '') return entry.file
  if (Array.isArray(entry.files) && entry.files.length > 0) return entry.files.join(', ')
  return message('social.noticeNoFile')
}

/** The moment a failed entry was meant to go out, in the host's own zone. */
function failureMoment(entry: FailedEntry): string {
  const at = typeof entry.publishAt === 'string' ? entry.publishAt : typeof entry.scheduledAt === 'string' ? entry.scheduledAt : undefined
  if (at === undefined) return message('social.noticeNoDate')
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleString(languageKind(currentLanguage()) === 'it' ? 'it-IT' : 'en-GB', {
    timeZone: 'Europe/Rome',
    dateStyle: 'short',
    timeStyle: 'short',
  })
}

/**
 * The Meta limit a failure names, when the message points at a known one.
 *
 * The two that actually happened — the stories of 2026-09-25 and 2026-09-28 —
 * were a clip longer than the 61s a story allows and a master over 100 MB. Both
 * are properties of the source media, not of the token, so the reader is told
 * to fix the file rather than to re-authorize.
 * @param error - the Python failure text.
 * @returns the advice, or undefined when the failure is not one of these.
 */
function failureHint(error: string): string | undefined {
  const text = error.toLowerCase()
  if (text.includes('max duration for stories') || text.includes('invalid video duration')) return message('social.hintStoryTooLong')
  if (text.includes('max 100mb') || text.includes('troppo grande')) return message('social.hintTooLarge')
  if (/\b(?:token|oauth)\b|session has expired|\(#?190\)/.test(text)) return message('social.hintToken')
  if (text.includes('file non trovato') || carries(error, 'social.fileNotInGallery', 'social.fileNotFoundNamed')) return message('social.hintFileGone')
  return undefined
}

/**
 * Compose the Telegram notice for one failed scheduled publication.
 * @param kind - "post" or "story".
 * @param entry - the queue entry left in `error`.
 * @returns the message body.
 */
function failureText(kind: 'post' | 'story', entry: FailedEntry): string {
  const label = message(kind === 'story' ? 'social.noticeStory' : 'social.noticePost')
  const error = typeof entry.error === 'string' && entry.error !== '' ? entry.error : message('social.noticeNoDetail')
  const hint = failureHint(error)
  const lines = [
    message('social.noticeFailed', { label }),
    '',
    `File: ${failureFile(entry)}`,
    message('social.noticeDueAt', { when: failureMoment(entry) }),
  ]
  if (typeof entry.source === 'string' && entry.source !== '') lines.push(message('social.noticeContent', { source: clipText(entry.source, 120) }))
  lines.push('', message('social.noticeReason'), clipText(error, 1500))
  if (hint !== undefined) lines.push('', message('social.noticeHint', { hint }))
  lines.push('', message(kind === 'story' ? 'social.noticeStoryStays' : 'social.noticePostStays'))
  return lines.join('\n')
}

/**
 * Notify the operator that a scheduled post or story ended the run in `error`.
 *
 * Called only by the scheduler: a publication sent by hand from the UI shows
 * its failure at once, and notifying it too would tell the operator what they
 * are already looking at.
 * @param kind - "post" or "story".
 * @param entry - the failed queue entry.
 */
export async function notifyPublishFailure(kind: 'post' | 'story', entry: FailedEntry): Promise<void> {
  await notifyWithPicture(failureText(kind, entry), entry.file ?? entry.files?.[0])
}

/**
 * Send a notice with the picture of the file it is about, when one can be
 * made; the text alone otherwise. The picture is removed once the notice is out.
 * @param text - the notice.
 * @param file - the gallery name or path of the published file.
 */
async function notifyWithPicture(text: string, file: string | undefined): Promise<void> {
  const preview = await previewOf(file)
  try {
    await notify(text, preview === undefined ? undefined : { photoPath: preview.path })
  } finally {
    await preview?.cleanup()
  }
}

/** The fields of a handled comment the attention notice reads. */
export interface AttentionComment {
  readonly id: string
  readonly text?: string
  readonly username?: string
  readonly author?: string
  readonly permalink?: string
  readonly classification?: string
  readonly replied?: boolean
  readonly replyError?: string
  readonly toldOwner?: boolean
}

/** How many comments one notice lists per group. */
const ATTENTION_PER_GROUP = 5

/**
 * The comments a pass could not handle on its own and the owner should see:
 * offensive ones (never hidden by the plugin), likely spam, questions left
 * without a reply, replies Meta refused — plus the pass's own failure.
 * @param entries - the comments the pass read.
 * @param passError - why the pass could not read or write, if it could not.
 * @returns the message body and the ids it names, or undefined when nothing needs the owner.
 */
export function commentsAttention(entries: readonly AttentionComment[], passError?: string): { readonly text: string; readonly ids: readonly string[] } | undefined {
  const fresh = entries.filter(entry => entry.toldOwner !== true)
  const groups: [Parameters<typeof message>[0], AttentionComment[]][] = [
    ['social.attentionOffensive', fresh.filter(e => e.classification === 'offensive')],
    ['social.attentionSpam', fresh.filter(e => e.classification === 'spam')],
    ['social.attentionQuestions', fresh.filter(e => e.classification === 'question' && e.replied !== true)],
    ['social.attentionReplyFailed', fresh.filter(e => typeof e.replyError === 'string' && e.replyError !== '' && e.classification !== 'question')],
  ]
  const lines: string[] = [message('social.attentionTitle')]
  const ids: string[] = []
  if (passError !== undefined && passError !== '') lines.push('', message('social.attentionPassError'), clipText(passError, 400))
  for (const [key, list] of groups) {
    if (list.length === 0) continue
    lines.push('', message(key, { count: String(list.length) }))
    for (const entry of list.slice(0, ATTENTION_PER_GROUP)) {
      const who = entry.username ?? entry.author ?? '?'
      lines.push(`• @${who.replace(/^@/, '')}: «${clipText((entry.text ?? '').replace(/\s+/g, ' ').trim(), 140)}»`)
      if (typeof entry.permalink === 'string' && entry.permalink !== '') lines.push(`  ${entry.permalink}`)
    }
    if (list.length > ATTENTION_PER_GROUP) lines.push(message('social.attentionMore', { count: String(list.length - ATTENTION_PER_GROUP) }))
    ids.push(...list.map(entry => entry.id))
  }
  if (lines.length === 1) return undefined
  lines.push('', message('social.attentionWhere'))
  return { text: lines.join('\n'), ids }
}

/** The fields of a published entry the success notice reads. */
export interface PublishedEntry {
  readonly kind?: string
  readonly files?: readonly string[]
  readonly file?: string
  readonly caption?: string
  readonly source?: string
  readonly instagramUrl?: string
  readonly permalink?: string
}

/** What comes next, for the last lines of the success notice. */
export interface PublishedNext {
  /** When the next scheduled post (or story) is due; absent when the queue is empty. */
  readonly nextAt?: string
  /** When the story made from this reel will run, if one was queued. */
  readonly storyAt?: string
}

/** A moment in the host's zone, short. */
function shortMoment(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleString(languageKind(currentLanguage()) === 'it' ? 'it-IT' : 'en-GB', {
    timeZone: 'Europe/Rome',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Compose the notice of a scheduled post or story that went out.
 * @param kind - "post" or "story".
 * @param entry - the published entry.
 * @param next - the queue after it.
 * @returns the message body.
 */
export function publishedText(kind: 'post' | 'story', entry: PublishedEntry, next: PublishedNext = {}): string {
  const lines = [kind === 'story'
    ? message('social.publishedStory')
    : message(entry.kind === 'reel' ? 'social.publishedReel' : entry.kind === 'carousel' ? 'social.publishedCarousel' : 'social.publishedPhoto')]
  const first = (kind === 'story' ? entry.source ?? '' : (entry.caption ?? '').split('\n')[0] ?? '').trim()
  if (first !== '') lines.push(`«${clipText(first, 90)}»`)
  const link = entry.instagramUrl ?? entry.permalink
  if (link !== undefined && link !== '') lines.push(link)
  lines.push('')
  if (next.storyAt !== undefined) lines.push(message('social.publishedStoryQueued', { when: shortMoment(next.storyAt) }))
  lines.push(next.nextAt === undefined
    ? message(kind === 'story' ? 'social.publishedNoNextStory' : 'social.publishedNoNext')
    : message(kind === 'story' ? 'social.publishedNextStory' : 'social.publishedNext', { when: shortMoment(next.nextAt) }))
  if (kind === 'post') lines.push(message('social.publishedReportLater'))
  return lines.join('\n')
}

/**
 * Tell the owner a scheduled post or story went out.
 *
 * Called by the scheduler only, like the failure notice: a publication sent
 * by hand is already in front of the person who sent it.
 * @param kind - "post" or "story".
 * @param entry - the published entry.
 * @param next - the queue after it.
 */
export async function notifyPublished(kind: 'post' | 'story', entry: PublishedEntry, next: PublishedNext = {}): Promise<void> {
  await notifyWithPicture(publishedText(kind, entry, next), entry.file ?? entry.files?.[0])
}
