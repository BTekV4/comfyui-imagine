/**
 * The story queue: one story a day, at eight, usually the reel of the day
 * before run again as a story (`queueStoryFor`), and the `…/social/stories`
 * routes that show and edit it.
 * @module social/stories
 */
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve, sep } from 'node:path'
import { readJsonFile } from '../../../server/vendor/atomic-write/index.ts'
import { probeMedia } from '../../../server/vendor/tool-comfy/media-tools.ts'
import { message } from '../../../server/src/messages.ts'
import { readObject, sendJson } from '../../../server/src/route-kit.ts'
import {
  instagramDir, log, mediaDir, normalizedDir, notify, queueStore, resolveMediaPath, routeCollection, socialSettings,
} from './context.ts'
import { clipText, notifyPublished, notifyPublishFailure } from './notify.ts'
import { execPython, mediaResultOf, refusalOf, STORY_PUBLISH_SCRIPT, TIMEOUTS } from './python.ts'
import { watermarkMedia, type MarkedMedia } from './watermark.ts'
import type { SocialStory } from '../../../shared/social-types.ts'

/**
 * One queued story, as `stories.json` keeps it: the wire type the page reads
 * (`shared/social-types.ts`), writable here where the queue changes it.
 */
export type Story = { -readonly [K in keyof SocialStory]: SocialStory[K] }

/** A Graph id or link from a script's JSON, as the record keeps it. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined
}

/** The fields of a published post a story is made from. */
export interface StorySource {
  readonly id: string
  readonly kind: string
  readonly files: readonly string[]
  readonly caption: string
  readonly publishedAt?: string
}

/**
 * The first day this plugin may put out a story: the `storiesFrom` setting,
 * empty for no floor.
 *
 * For an account whose stories another publisher was still putting out: two
 * schedulers cannot see each other's queues, and the account's own rule is
 * one story a day, so the hand-over is a date rather than a negotiation. Move
 * it forward if the other queue is extended.
 */
const storiesFrom = (): string | undefined => socialSettings().storiesFrom()
/** The hour a story goes out, local time — the account's habit. */
const STORY_HOUR = 8
/** How long after its reel a story follows, when the calendar is free. */
const STORY_DELAY_HOURS = 24
/**
 * What a story may weigh, in MB.
 *
 * The same number the publisher enforces locally, and Meta's documented
 * ceiling for a stories video.
 */
const STORY_MAX_MB = 100
/**
 * How long a story may run, in seconds.
 *
 * Meta's own boundary: its rejection reads "Max duration for stories is 61.0",
 * while the published documentation says 60. The guard sits on the number Meta
 * enforces, so a clip it would accept is not thrown away a day early; the
 * notices quote it and 60 is the figure to aim for.
 */
const STORY_MAX_SECONDS = 61

/** The queue, held in memory and written through, like the posts. */
export const storiesStore = queueStore<Story>('stories.json', 'stories')

/**
 * The duration of one video, in seconds, read with ffprobe.
 * @param file - the absolute path of the media.
 * @returns the duration, or undefined when ffprobe cannot read one.
 */
async function videoSeconds(file: string): Promise<number | undefined> {
  const { duration } = await probeMedia(file)
  if (duration > 0) return duration
  log(`ffprobe could not read the duration of ${file}`)
  return undefined
}

/**
 * Why one file cannot go out as a story, or undefined when it can.
 *
 * A story is published from the reel's own master, and the two reach different
 * limits: a reel may run minutes and weigh far more than a story ever can.
 * Checking here — before the story reaches the queue — is what keeps a
 * known-doomed attempt out of the calendar, where it would spend a day's slot
 * and only then be rejected by Meta, after the upload.
 *
 * A file that cannot be stat'ed is a problem (nothing could be published from
 * it), while a duration ffprobe cannot read is not: the media may be perfectly
 * publishable, and a real failure is reported by the publish notice instead.
 * @param file - the absolute path of the candidate story media.
 * @returns what to show about the first limit broken.
 */
async function storyMediaProblem(file: string): Promise<{ summary: string; detail: string } | undefined> {
  let sizeMb: number
  try {
    sizeMb = (await stat(file)).size / (1024 * 1024)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      summary: message('social.fileUnreadableShort', { reason }),
      detail: message('social.fileUnreadable', { reason }),
    }
  }
  if (sizeMb > STORY_MAX_MB) {
    return {
      summary: message('social.storyTooHeavy', { size: sizeMb.toFixed(1), max: STORY_MAX_MB }),
      detail: message('social.storyWeight', { size: sizeMb.toFixed(1), max: STORY_MAX_MB }),
    }
  }
  const seconds = await videoSeconds(file)
  if (seconds === undefined || seconds <= STORY_MAX_SECONDS) return undefined
  return {
    summary: message('social.storyTooLong', { seconds: seconds.toFixed(1), max: STORY_MAX_SECONDS }),
    detail: message('social.storyDuration', { seconds: seconds.toFixed(1), max: STORY_MAX_SECONDS }),
  }
}

/** The calendar day one instant falls on, in the host's own zone. */
function dayKeyOf(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * The Meta-ready master for one rendered clip, when the reel left one behind.
 * @param name - the gallery file name the post was published from.
 * @returns the path to publish, or undefined when neither file is there.
 */
async function storyFileFor(name: string): Promise<string | undefined> {
  const stem = name.replace(/\.[^.]+$/, '')
  const normalized = join(normalizedDir(), `${stem}_hermes_1080x1920_h264.mp4`)
  try {
    if ((await stat(normalized)).isFile()) return normalized
  } catch {
    // No conformed master; the raw render is the remaining candidate.
  }
  return resolveMediaPath(name)
}

/**
 * An absolute story path, accepted only when it is a file inside the gallery
 * or the reel publisher's conformed masters.
 * @param path - the path the caller named.
 * @returns the normalised path, or undefined.
 */
async function storyPathInside(path: string): Promise<string | undefined> {
  const target = resolve(path)
  const inside = [mediaDir(), normalizedDir()].some(dir => target.startsWith(resolve(dir) + sep))
  if (!inside) return undefined
  try {
    return (await stat(target)).isFile() ? target : undefined
  } catch {
    return undefined
  }
}

/**
 * The next day this account may put out a story.
 *
 * One a day is the whole rule: the day is the slot, and a day already spoken
 * for pushes the next story to the one after. Days before the hand-over
 * (`storiesFrom`) belong to the other publisher and are never offered.
 * @param after - the earliest acceptable instant.
 * @param queued - the stories already in the queue.
 * @returns when the story should go out.
 */
function nextStorySlot(after: Date, queued: readonly Story[]): Date {
  const taken = new Set(queued.map(entry => dayKeyOf(new Date(entry.publishAt))))
  const from = storiesFrom()
  const floor = from === undefined ? 0 : new Date(`${from}T00:00:00`).getTime()
  const day = new Date(Math.max(after.getTime(), floor))
  day.setHours(STORY_HOUR, 0, 0, 0)
  // A slot that has already gone past today is no slot at all.
  while (taken.has(dayKeyOf(day)) || day.getTime() <= Date.now()) day.setDate(day.getDate() + 1)
  return day
}

/**
 * Put one published reel in line to run again as a story.
 *
 * Never throws: it is called on the back of a successful publish, and a story
 * that could not be queued must not turn the post that did go out into a
 * failure.
 * @param post - the reel that has just been published.
 */
export async function queueStoryFor(post: StorySource): Promise<void> {
  try {
    if (post.kind !== 'reel') return
    const queued = await storiesStore.load()
    if (queued.some(entry => entry.postId === post.id)) return
    const name = post.files[0]
    if (name === undefined) return
    const file = await storyFileFor(name)
    if (file === undefined) {
      log(`no file for the story of post ${post.id}`)
      return
    }
    // The reel's own master is often too long or too heavy for a story, and
    // a doomed attempt would only spend a day's slot before Meta rejected
    // it. The check happens here, so the calendar never holds one.
    const problem = await storyMediaProblem(file)
    if (problem !== undefined) {
      log(`story not queued for post ${post.id}: ${problem.summary}`)
      await notify([
        message('social.storyNotScheduledTitle'),
        '',
        message('social.storyReelOut', { id: post.id }),
        `File: ${file}`,
        problem.detail,
        '',
        message('social.storyWouldBeRefused'),
      ].join('\n'))
      return
    }
    const after = new Date(Date.parse(post.publishedAt ?? new Date().toISOString()) + STORY_DELAY_HOURS * 3_600_000)
    const at = nextStorySlot(after, queued)
    queued.push({
      id: randomUUID(),
      postId: post.id,
      file,
      source: (post.caption.split('\n')[0] ?? '').slice(0, 80),
      publishAt: at.toISOString(),
      status: 'scheduled',
      createdAt: new Date().toISOString(),
    })
    await storiesStore.save()
    log(`story queued for ${at.toISOString()} from reel ${post.id}`)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    log(`could not queue the story: ${reason}`)
    await notify([
      message('social.storyNotQueuedTitle'),
      '',
      message('social.storyNotQueued', { id: post.id }),
      '',
      message('social.noticeReason'),
      clipText(reason, 1000),
      '',
      message('social.checkStories'),
    ].join('\n'))
  }
}

/** The publisher's freeze switch (a file in the Instagram project). */
const freezePath = (): string => join(instagramDir(), 'state', 'PUBLISH_FREEZE.json')

/** The freeze file's verdict, kept until the file's mtime moves. */
let freezeCache: { readonly mtime: number; readonly frozen: boolean } | undefined

/**
 * Whether the account is allowed to put out stories right now.
 *
 * `allow_stories` overrides a freeze, which is how the account has been run
 * since 2026-08-21: the feed, comments and likes can be frozen while one story
 * a day keeps going.
 *
 * The scheduler asks every 30 s; the file is read again only when its mtime
 * moves (until 2026-10-25 it was read at every tick).
 * @returns true when the freeze forbids stories.
 */
async function storiesFrozen(): Promise<boolean> {
  let mtime: number
  try {
    mtime = (await stat(freezePath())).mtimeMs
  } catch {
    freezeCache = undefined
    return false
  }
  if (freezeCache?.mtime === mtime) return freezeCache.frozen
  const freeze = await readJsonFile(freezePath()) as { allow_stories?: unknown; frozen?: unknown; do_not_publish?: unknown } | null | undefined
  const frozen = freeze === undefined || freeze === null || freeze.allow_stories === true
    ? false
    : freeze.frozen === true || freeze.do_not_publish === true
  freezeCache = { mtime, frozen }
  return frozen
}

/**
 * Publish one queued story and record what happened.
 *
 * Never throws, and never retries on its own: a story left in `error` is one
 * someone can look at, where a retry loop against a broken token would keep
 * posting.
 * @param entry - the queued story, updated in place.
 * @returns the entry, in its new state.
 */
async function runStory(entry: Story): Promise<Story> {
  entry.status = 'publishing'
  entry.error = undefined
  await storiesStore.save()
  // The mark applies to stories too (2026-11-11); the temporary copies are
  // deleted at the end of the publication either way.
  let marked: MarkedMedia | undefined
  try {
    marked = await watermarkMedia([entry.file])
    const result = await execPython(STORY_PUBLISH_SCRIPT(), [marked.paths[0] ?? entry.file, '--allow-direct-publish'], TIMEOUTS.story)
    // The script's own refusal (see runPublish); stories are never retried on their own.
    if (result?.ok === false) throw new Error(refusalOf(result, message('social.scriptRefused')))
    const text = typeof result?.output === 'string' ? result.output : ''
    // Read after the story is out: a malformed tag must not record a
    // published story as failed, which a manual "Pubblica" would then repeat.
    let first: { media_id?: unknown; permalink?: unknown } | undefined
    try {
      const tagged = mediaResultOf(text)
      first = Array.isArray(tagged) ? tagged[0] as { media_id?: unknown; permalink?: unknown } | undefined : undefined
    } catch {
      log(`story ${entry.id}: MEDIA_RESULT not readable`)
    }
    entry.status = 'published'
    entry.publishedAt = new Date().toISOString()
    entry.mediaId = textOf(first?.media_id)
    entry.permalink = textOf(first?.permalink) ?? /https:\/\/www\.instagram\.com\/stories\/[^\s"]+/.exec(text)?.[0]
  } catch (error: unknown) {
    entry.status = 'error'
    entry.error = error instanceof Error ? error.message : String(error)
    log(`story ${entry.id} failed: ${entry.error}`)
  } finally {
    if (marked !== undefined) await marked.cleanup()
  }
  await storiesStore.save()
  return entry
}

/**
 * Put out the story whose day has come, at most one.
 *
 * The cap is the account's rule and the reason this cannot simply publish
 * everything that is due: a queue that has fallen behind must catch up one day
 * at a time, not empty itself in a single tick.
 */
export async function runDueStories(): Promise<void> {
  if (await storiesFrozen()) return
  const queued = await storiesStore.load()
  const today = dayKeyOf(new Date())
  if (queued.some(entry => entry.status === 'published' && entry.publishedAt !== undefined && dayKeyOf(new Date(entry.publishedAt)) === today)) return
  if (queued.some(entry => entry.status === 'publishing')) return
  const now = Date.now()
  const due = queued
    .filter(entry => entry.status === 'scheduled' && Date.parse(entry.publishAt) <= now)
    .sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt))[0]
  if (due === undefined) return
  log(`story ${due.id} is due, publishing`)
  await runStory(due)
  if (due.status === 'error') await notifyPublishFailure('story', due)
  if ((due as Story).status === 'published') {
    const nextAt = queued
      .filter(entry => entry.status === 'scheduled')
      .map(entry => entry.publishAt)
      .sort()[0]
    await notifyPublished('story', due, nextAt === undefined ? {} : { nextAt })
  }
}

/**
 * Handle the …/social/stories routes: the story queue.
 *
 * GET    /stories              list every story, soonest first
 * POST   /stories              queue one by hand
 * PATCH  /stories/<id>         move its date
 * DELETE /stories/<id>         drop it
 * POST   /stories/<id>/publish send it now
 * @param req - incoming request.
 * @param res - server response.
 * @param subpath - the path under /social.
 */
export async function handleStories(req: IncomingMessage, res: ServerResponse, subpath: string): Promise<void> {
  const list = await storiesStore.load()
  await routeCollection<Story>(req, res, subpath, '/stories', {
    notFound: message('social.storyNotFound'),
    find: async id => list.find(entry => entry.id === id),
    list: async () => {
      sendJson(res, 200, {
        ok: true,
        stories: [...list].sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt)),
        from: storiesFrom() ?? '',
        hour: STORY_HOUR,
      })
    },
    create: async () => {
      const body = await readObject(req)
      const name = typeof body.file === 'string' ? body.file : ''
      if (name === '') return sendJson(res, 400, { error: message('social.storyFileRequired') })
      // An absolute path only inside the two folders a story comes from: any
      // path at all let a client queue any file on the box for upload to
      // Drive and Instagram.
      const file = name.startsWith('/') ? await storyPathInside(name) : await storyFileFor(name)
      if (file === undefined) return sendJson(res, 404, { error: message('social.fileNotFoundNamed', { name }) })
      const problem = await storyMediaProblem(file)
      if (problem !== undefined) return sendJson(res, 400, { error: message('social.storyCannotGo', { reason: problem.summary }) })
      const at = typeof body.publishAt === 'string' && body.publishAt.length > 0
        ? new Date(body.publishAt)
        : nextStorySlot(new Date(), list)
      if (Number.isNaN(at.getTime())) return sendJson(res, 400, { error: message('social.dateInvalid', { value: String(body.publishAt) }) })
      const entry: Story = {
        id: randomUUID(),
        file,
        source: typeof body.source === 'string' ? body.source : '',
        publishAt: at.toISOString(),
        status: 'scheduled',
        createdAt: new Date().toISOString(),
      }
      if (typeof body.postId === 'string') entry.postId = body.postId
      list.push(entry)
      await storiesStore.save()
      sendJson(res, 200, { ok: true, story: entry })
    },
    actions: {
      'POST publish': async (_req, _res, entry) => {
        // Same guard as the posts: a story already out, or on its way, is not sent again.
        if (entry.status === 'publishing' || entry.status === 'published') {
          return sendJson(res, 409, { error: message(entry.status === 'published' ? 'social.storyAlreadyPublished' : 'social.publishInProgress') })
        }
        sendJson(res, 200, { ok: true, story: await runStory(entry) })
      },
      PATCH: async (_req, _res, entry) => {
        const body = await readObject(req)
        const rescheduled = typeof body.publishAt === 'string' && body.publishAt.length > 0
        if (rescheduled) {
          const at = new Date(body.publishAt as string)
          if (Number.isNaN(at.getTime())) return sendJson(res, 400, { error: message('social.dateInvalid', { value: String(body.publishAt) }) })
          entry.publishAt = at.toISOString()
          // A moved date is a new intention: one that had failed goes back in
          // line rather than staying stuck on its old error.
          if (entry.status === 'error') entry.status = 'scheduled'
        }
        if (typeof body.source === 'string') entry.source = body.source
        // Re-arming a story re-checks the media: one that failed on its
        // duration must not go back in line to fail the same way.
        if (rescheduled && entry.status === 'scheduled') {
          const problem = await storyMediaProblem(entry.file)
          if (problem !== undefined) {
            entry.status = 'error'
            entry.error = message('social.storyCannotGo', { reason: problem.summary })
            await storiesStore.save()
            return sendJson(res, 400, { error: entry.error })
          }
        }
        await storiesStore.save()
        sendJson(res, 200, { ok: true, story: entry })
      },
      DELETE: async (_req, _res, entry) => {
        list.splice(list.indexOf(entry), 1)
        await storiesStore.save()
        sendJson(res, 200, { ok: true })
      },
    },
  })
}
