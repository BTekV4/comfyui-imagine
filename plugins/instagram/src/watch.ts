/**
 * The owner's watch over the things that break in silence.
 *
 * - The queue running out: every evening, when the posts scheduled end within
 *   two days (or the stories within three), one notice — before the account
 *   goes quiet, not after.
 * - The comment tokens: once a day Meta is asked whether the page and user
 *   tokens still work (the same check as the settings page's button). A token
 *   refused stops the replies to comments without any other sign.
 * - The queue that cannot be written: the queue keeps working from memory, and
 *   the next restart loses every scheduled post. The page shows it; the owner
 *   has to hear it.
 *
 * The days a notice was sent are kept in `notices.json` in the state folder,
 * so a restart does not send the same evening notice twice.
 * @module social/watch
 */
import { join } from 'node:path'
import { readJsonFile } from '../../../server/vendor/atomic-write/index.ts'
import { currentLanguage, languageKind, message } from '../../../server/src/messages.ts'
import { romeClock } from './clock.ts'
import { errorText, log, notify, recordFile, stateDir } from './context.ts'
import { postsStore } from './posts.ts'
import { storiesStore } from './stories.ts'
import { checkFacebookTokens } from './token-check.ts'
import { readFacebookTokenState } from './token.ts'

/** From this hour (Rome) the evening queue check runs. */
export const QUEUE_CHECK_HOUR = 20
/** A post queue that ends within this many hours is running low. */
export const POSTS_LOW_HOURS = 48
/** A story queue that ends within this many hours is running low. */
export const STORIES_LOW_HOURS = 72
/** From this hour (Rome) the daily token check runs. */
const TOKEN_CHECK_HOUR = 10
/** How often the Meta check may be retried when Meta did not answer. */
const TOKEN_RETRY_MS = 60 * 60_000

/** The file. */
interface WatchState {
  queueDay?: string
  facebookDay?: string
}

let state: WatchState | undefined
let lastFacebookTry = 0
/** The write errors already told, so one broken disk is one notice. */
let toldWriteError: string | undefined
const record = recordFile(() => join(stateDir(), 'notices.json'), 'notices', () => state ?? {})

async function load(): Promise<WatchState> {
  if (state !== undefined) return state
  const raw = await readJsonFile(record.path) as WatchState | undefined
  state = {
    ...typeof raw?.queueDay === 'string' ? { queueDay: raw.queueDay } : {},
    ...typeof raw?.facebookDay === 'string' ? { facebookDay: raw.facebookDay } : {},
  }
  return state
}

/** For the tests. */
export function resetWatchForTests(): void {
  state = undefined
  lastFacebookTry = 0
  toldWriteError = undefined
}

/** A moment in Rome, short: «dom 16 nov, 19:00». */
function moment(at: number): string {
  return new Date(at).toLocaleString(languageKind(currentLanguage()) === 'it' ? 'it-IT' : 'en-GB', {
    timeZone: 'Europe/Rome',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * The evening notice about the queues, or undefined when both have room.
 * @param posts - when each scheduled post is due (ISO).
 * @param stories - when each scheduled story is due (ISO).
 * @param now - the moment of the check.
 * @returns the message body, or undefined.
 */
export function queueLowText(posts: readonly string[], stories: readonly string[], now: number): string | undefined {
  const future = (list: readonly string[]): number[] => list.map(at => Date.parse(at)).filter(at => !Number.isNaN(at) && at > now).sort((a, b) => a - b)
  const lines: string[] = []
  const nextPosts = future(posts)
  const lastPost = nextPosts.at(-1)
  if (lastPost === undefined) {
    lines.push(message('social.queueEmpty'))
  } else if (lastPost - now < POSTS_LOW_HOURS * 3_600_000) {
    const tomorrow = romeClock(new Date(now + 86_400_000)).day
    const count = nextPosts.filter(at => romeClock(new Date(at)).day === tomorrow).length
    lines.push(message('social.queueLow', { count: String(nextPosts.length), when: moment(lastPost) }))
    lines.push(message('social.queueTomorrow', { count: String(count) }))
  }
  const nextStories = future(stories)
  const lastStory = nextStories.at(-1)
  if (lastStory === undefined) lines.push(message('social.storiesEmpty'))
  else if (lastStory - now < STORIES_LOW_HOURS * 3_600_000) lines.push(message('social.storiesLow', { when: moment(lastStory) }))
  if (lines.length === 0) return undefined
  return [message('social.queueTitle'), '', ...lines].join('\n')
}

/** The evening check of the queues, once a day. */
async function queuePass(current: WatchState, now: Date): Promise<void> {
  const clock = romeClock(now)
  if (clock.hour < QUEUE_CHECK_HOUR || current.queueDay === clock.day) return
  current.queueDay = clock.day
  await record.save()
  const posts = (await postsStore.load()).filter(p => p.status === 'scheduled' && typeof p.scheduledAt === 'string').map(p => p.scheduledAt as string)
  const stories = (await storiesStore.load()).filter(s => s.status === 'scheduled').map(s => s.publishAt)
  const text = queueLowText(posts, stories, now.getTime())
  if (text !== undefined) await notify(text)
}

/** The daily check of the comment tokens. */
async function facebookPass(current: WatchState, now: Date): Promise<void> {
  const clock = romeClock(now)
  if (clock.hour < TOKEN_CHECK_HOUR || current.facebookDay === clock.day) return
  if (now.getTime() - lastFacebookTry < TOKEN_RETRY_MS) return
  lastFacebookTry = now.getTime()
  if (!(await readFacebookTokenState()).hasToken) return
  const check = await checkFacebookTokens()
  // Meta not answering is not news: the next try is in an hour.
  if (check.verdict === 'unknown') {
    log(`comment tokens not checked: ${check.error ?? 'no answer'}`)
    return
  }
  current.facebookDay = clock.day
  await record.save()
  if (check.verdict !== 'invalid') return
  const reasons = [
    check.page?.valid === false ? message('social.fbTokenPageRefused', { reason: check.page.error ?? '?' }) : undefined,
    check.user?.valid === false ? message('social.fbTokenUserRefused', { reason: check.user.error ?? '?' }) : undefined,
  ].filter((line): line is string => line !== undefined)
  await notify([message('social.fbTokenInvalidNotice'), '', ...reasons, '', message('social.fbTokenInvalidHint')].join('\n'))
}

/** A queue that can no longer be written, told once, and its recovery. */
async function writePass(): Promise<void> {
  const error = postsStore.error ?? storiesStore.error
  if (error === toldWriteError) return
  const before = toldWriteError
  toldWriteError = error
  if (error !== undefined) await notify([message('social.queueWriteNotice'), '', error, '', message('social.queueWriteHint')].join('\n'))
  else if (before !== undefined) await notify(message('social.queueWriteBack'))
}

/**
 * The scheduler's watch pass.
 * @param now - the moment of the pass (the tests set it).
 */
export async function runWatch(now: Date = new Date()): Promise<void> {
  try {
    await writePass()
    const current = await load()
    await queuePass(current, now)
    await facebookPass(current, now)
  } catch (error: unknown) {
    log(`watch pass failed: ${errorText(error)}`)
  }
}
