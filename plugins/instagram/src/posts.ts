/**
 * The publication queue: photos, reels and carousels sent through the Python
 * publishers, on a date or at once, with a retry for transient failures and
 * the `…/social/posts` routes that show and edit it.
 * @module social/posts
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { message } from '../../../server/src/messages.ts'
import { readObject, sendJson, writeJsonTagged } from '../../../server/src/route-kit.ts'
import { carries, isDryRun, log, queueStore, resolveMediaPath, routeCollection } from './context.ts'
import { notifyPublished, notifyPublishFailure } from './notify.ts'
import { AI_LABEL_FLAG, CAROUSEL_PUBLISH_SCRIPT, execPython, mediaResultOf, PHOTO_PUBLISH_SCRIPT, REEL_PUBLISH_SCRIPT, refusalOf, TIMEOUTS, type ScriptResult } from './python.ts'
import { queueStoryFor, storiesStore } from './stories.ts'
import { watermarkMedia, type MarkedMedia } from './watermark.ts'
import type { SocialPost } from '../../../shared/social-types.ts'

/**
 * One queued post, as `posts.json` keeps it: the wire type the page reads
 * (`shared/social-types.ts`), writable here where the queue changes it.
 */
export type Post = { -readonly [K in keyof SocialPost]: SocialPost[K] }

/**
 * The queue, held in memory and written through on every change.
 *
 * One process owns this file, so the list is the authority and the file is its
 * record; writes are chained so two requests landing together cannot
 * interleave a read-modify-write and lose one of the two changes.
 */
export const postsStore = queueStore<Post>('posts.json', 'posts')

/* -------------------------------------------------- retry on transient failures */

/**
 * How many times a post is sent again before it is left as a failure.
 *
 * Three attempts covers a slow spell on the way to Drive or a Graph hiccup;
 * beyond that the cause is not the weather and a fourth try only delays the
 * moment the account owner hears about it.
 */
const PUBLISH_MAX_ATTEMPTS = 3
/** How long to wait between two attempts. */
const PUBLISH_RETRY_MS = 300_000

/**
 * Whether an error is worth another attempt.
 *
 * The scheduler's own comment explains why nothing was retried before: a dead
 * token would republish forever. That reasoning holds for a permanent failure
 * and not for a transient one, and the two read very differently in the
 * publisher's stderr — so the decision is by content, the same way failureHint
 * already reads these messages.
 *
 * Transient: a slow or interrupted upload, a timeout, a 5xx or rate-limit from
 * Meta, a connection that dropped. Permanent: a missing file, a clip over
 * Meta's ceilings, an expired or invalid token, a rejected media.
 * @param message - the error text recorded on the post.
 * @returns true when sending it again could plausibly work.
 */
function isTransientPublishError(message: string): boolean {
  const text = message.toLowerCase()
  /*
   * A watchdog kill is transient by construction, and it is read before
   * anything else: execPython now reports the tail of both streams, so the
   * text carries the script's own log, where a word from the list below can
   * appear for reasons that have nothing to do with why the run was killed.
   * The marker is the one execPython writes, not a word the script could.
   */
  if (carries(text, 'social.scriptTimeout')) return true
  // Permanent first: these cannot be fixed by waiting, and a retry would only
  // postpone the notice that something needs the owner's hand.
  const permanent = [
    'file non trovato', 'nessun file da pubblicare',
    'troppo grande', 'max 100mb', 'max duration', 'invalid video duration',
    "non puo' uscire come storia", 'limite',
    'invalid oauth', 'cannot parse access token', 'session has expired',
    'token has expired', 'error validating access token',
    'code": 190', 'code": 100', 'unsupported', 'not supported',
  ]
  if (permanent.some(needle => text.includes(needle))) return false
  // The plugin's own refusals, in either language (the list above has the
  // Italian ones as they were written before the table).
  if (carries(text, 'social.fileNotInGallery', 'social.noFileToPublish', 'social.storyCannotGo', 'social.fileNotFoundNamed')) return false
  /*
   * Transient: something on the wire, named as such. The list used to carry
   * `drive`, `rclone` and `upload` too, from when the only text available was
   * a one-line failure. It cannot stay now that the message holds the tail of
   * the script's own log: every publication uploads to Drive through rclone,
   * so those three words are in almost every failure, transient or not, and
   * they would have made the default "retry" for anything not spelled out in
   * the permanent list above — three uploads of ~90MB and ten minutes before
   * the owner hears about a failure that was never going to resolve itself.
   * A genuinely stuck upload still gets its retry: the watchdog kills it and
   * the timeout marker is read before any of this.
   */
  const transient = [
    'timed out', 'timeout', 'etimedout', 'econnreset', 'econnrefused',
    'enotfound', 'socket hang up', 'connection reset',
    'network is unreachable', 'broken pipe',
    'temporarily unavailable', 'service unavailable',
    'rate limit', 'too many requests', 'please retry', 'try again',
    'internal server error', 'bad gateway', 'gateway timeout',
    'status 429', 'status 500', 'status 502', 'status 503', 'status 504',
  ]
  if (transient.some(needle => text.includes(needle))) return true
  // An unknown failure is not retried: the old default was no retry at all,
  // and inventing one for a message nobody has classified risks the loop the
  // scheduler comment warns about.
  return false
}

/**
 * Forget the attempts a finished run spent.
 *
 * The counters belong to the run, not to the post, so every path that ends one
 * clears them: a publication that succeeded, one recorded as published after
 * the fact, and a failed post a new date puts back in the queue. Left behind,
 * they would make the next run start from a tally already paid off — a post
 * that had spent its three attempts would get none at all, because
 * scheduleRetry would read attempts >= PUBLISH_MAX_ATTEMPTS on the first
 * failure and hand it straight to the notice.
 * @param post - the post whose counters to clear, updated in place.
 */
function clearRetryState(post: Post): void {
  post.attempts = undefined
  post.nextAttemptAt = undefined
}

/**
 * Note that an attempt failed and decide whether the post goes back in line.
 *
 * Kept separate from runPublish so the queue write and the notification stay
 * in one place, and so the counters it adds (attempts, nextAttemptAt) are
 * visible in posts.json rather than implied.
 * @param post - the post that failed, updated in place.
 * @returns true when the scheduler should try again later.
 */
function scheduleRetry(post: Post): boolean {
  const attempts = (typeof post.attempts === 'number' ? post.attempts : 0) + 1
  post.attempts = attempts
  const worthRetrying = attempts < PUBLISH_MAX_ATTEMPTS && isTransientPublishError(post.error ?? '')
  if (!worthRetrying) {
    post.nextAttemptAt = undefined
    return false
  }
  post.nextAttemptAt = new Date(Date.now() + PUBLISH_RETRY_MS).toISOString()
  return true
}

/* ------------------------------- recording a publish that happened outside the queue */

/**
 * The Graph id inside an Instagram post URL.
 *
 * The URLs Meta hands back are shortcodes (`/reel/Dd9G3fCFbtr/`), which are not
 * the numeric id the Graph API uses, so the shortcode is what gets resolved
 * against the account's own media below rather than being translated here.
 * @param url - the post address.
 * @returns the shortcode, or undefined when the URL carries none.
 */
function instagramMediaId(url: string): string | undefined {
  return /\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/.exec(url)?.[1]
}

/**
 * Ask Meta whether one shortcode is a post of this account.
 *
 * This is what keeps the `published` state honest: the queue refuses to set it
 * through PATCH because a faked publish is the one lie the history must not
 * tell, and a route that could write it on request would be the same hole with
 * a different name. The answer comes from the account's own media list, so a
 * URL that belongs to somebody else — or to nobody — is refused.
 *
 * The lookup goes through the oldest of the account's media, which is enough
 * for the hand-made publishes this is for and avoids paging the whole history.
 * @param shortcode - the code from the post URL.
 * @returns whether the post is really there, and when it went out.
 */
async function verifyMediaOnAccount(shortcode: string): Promise<
  { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly mediaId: unknown; readonly permalink: unknown; readonly timestamp: unknown }
> {
  const result: ScriptResult = await execPython(REEL_PUBLISH_SCRIPT(), ['--verify-media', shortcode], TIMEOUTS.quick).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }))
  if (result?.found !== true) {
    return {
      ok: false,
      reason: typeof result?.error === 'string' ? result.error : message('social.postNotOnAccount', { code: shortcode }),
    }
  }
  return {
    ok: true,
    mediaId: result.media_id,
    permalink: result.permalink,
    timestamp: result.timestamp,
  }
}

/* ------------------------------------------------------------ publishing */

/** The fields a caller may set on a post, validated as they arrive. */
function readPostInput(body: Record<string, unknown>): Pick<Post, 'kind' | 'files' | 'caption' | 'hashtags' | 'aiLabel' | 'scheduledAt'> {
  const files = Array.isArray(body.files) ? body.files.filter((file): file is string => typeof file === 'string' && file.length > 0) : []
  const kind = body.kind === 'reel' || body.kind === 'carousel' ? body.kind : 'photo'
  return {
    kind,
    files,
    caption: typeof body.caption === 'string' ? body.caption : '',
    hashtags: typeof body.hashtags === 'string' ? body.hashtags : '',
    // On unless the caller says otherwise: the account's editorial policy
    // prefers the label, and everything Imagine makes is generated.
    aiLabel: body.aiLabel !== false,
    scheduledAt: typeof body.scheduledAt === 'string' && body.scheduledAt.length > 0 ? body.scheduledAt : undefined,
  }
}

/**
 * Find the published post's address in whatever the script printed.
 *
 * All three publish scripts put their JSON result on **stderr** and only a
 * human line on stdout, so `execPython`'s parse never saw `instagram_url` and
 * every post published from here was recorded without its link — all three of
 * them, up to 2026-09-06. The reel and the carousel do put the result on stdout
 * behind `MEDIA_RESULT=`; the photo prints only a sentence with the URL in it.
 * Read all three rather than change the scripts, which other tools may run too.
 * @param result - what `execPython` returned.
 * @returns the permalink, or undefined when the post has none yet.
 */
function readPublishedUrl(result: ScriptResult | undefined): string | undefined {
  if (result === null || typeof result !== 'object') return undefined
  if (typeof result.instagram_url === 'string' && result.instagram_url.length > 0) return result.instagram_url
  const text = typeof result.output === 'string' ? result.output : ''
  let tagged: unknown
  try {
    tagged = mediaResultOf(text)
  } catch {
    // Not JSON after all; the URL below is the remaining chance.
  }
  if (tagged !== null && typeof tagged === 'object' && !Array.isArray(tagged)) {
    const url = (tagged as { instagram_url?: unknown }).instagram_url
    if (typeof url === 'string' && url.length > 0) return url
  }
  // Meta does not always have the permalink ready right after publishing, so
  // its absence here is normal and the reconciliation below fills it in.
  return /https:\/\/www\.instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/?/.exec(text)?.[0]
}

/**
 * Turn the publish scripts' stderr into the step the queue shows.
 * @param total - how many files the post sends.
 * @returns a function from one line to the step, or undefined for a line that
 * is not one (banners, JSON dumps).
 */
function publishSteps(total: number): (line: string) => string | undefined {
  let uploads = 0
  return (line) => {
    if (/Upload .*Google Drive/.test(line)) {
      uploads += 1
      return total > 1 ? message('social.stepDrivePhoto', { n: Math.min(uploads, total), total }) : message('social.stepDrive')
    }
    const child = /Container figlio (\d+)\/(\d+)/.exec(line)
    if (child !== null) return message('social.stepChild', { n: child[1] ?? '', total: child[2] ?? '' })
    if (line.includes('Contenitore CAROUSEL')) return message('social.stepCarousel')
    if (line.includes('container IMAGE')) return message('social.stepImage')
    if (line.includes('container REELS')) return message('social.stepReel')
    const poll = /\[(?:poll|step2)\] (?:Poll )?(\d+)\/(\d+)/.exec(line)
    if (poll !== null) return message('social.stepPoll', { n: poll[1] ?? '', total: poll[2] ?? '' })
    if (line.includes('Elaborazione')) return message('social.stepProcessing')
    if (line.startsWith('[gpu-ai]') || line.startsWith('[cpu-fallback]')) return message('social.stepUpscale')
    if (line.startsWith('[preflight]')) return message('social.stepPreflight')
    if (line.startsWith('[quota]')) return message('social.stepQuota')
    if (line.includes('Pubblicazione...')) return message('social.stepPublish')
    if (line.startsWith('[verify]')) return message('social.stepVerify')
    return undefined
  }
}

/** A failure the publish script reported itself, as `{"ok": false}`: never retried automatically. */
class ScriptRefusal extends Error {}

/**
 * Publish one post through the Python scripts and record what happened.
 *
 * Never throws: the scheduler calls it unattended, and a post that fails has
 * to end up as a readable error in the queue rather than as an unhandled
 * rejection in the journal.
 * @param post - the queued post, which is updated in place.
 * @param dryRun - rehearse a carousel without publishing it.
 * @returns the post, in its new state.
 */
async function runPublish(post: Post, dryRun = false): Promise<Post> {
  post.status = 'publishing'
  post.error = undefined
  post.progress = message('social.stepFiles')
  post.updatedAt = new Date().toISOString()
  await postsStore.save()
  /*
   * The mark on the files that go out (2026-11-11): the marked copies live in
   * a temporary folder and are deleted as soon as the post is done, whether
   * it went well or not.
   */
  let marked: MarkedMedia | undefined
  try {
    const paths: string[] = []
    for (const name of post.files) {
      const path = await resolveMediaPath(name)
      if (path === undefined) throw new Error(message('social.fileNotInGallery', { name }))
      paths.push(path)
    }
    const first = paths[0]
    if (first === undefined) throw new Error(message('social.noFileToPublish'))
    marked = await watermarkMedia(paths)
    const sending = marked.paths
    const fullCaption = post.hashtags ? `${post.caption}\n\n${post.hashtags}` : post.caption
    // A carousel is its own Graph API sequence — a container per image, then
    // one CAROUSEL container carrying the caption — so it has its own script
    // rather than sending the first picture and dropping the rest.
    const carousel = post.kind === 'carousel' && paths.length > 1
    const script = carousel ? CAROUSEL_PUBLISH_SCRIPT() : post.kind === 'reel' ? REEL_PUBLISH_SCRIPT() : PHOTO_PUBLISH_SCRIPT()
    const args = [...carousel ? sending : [sending[0] ?? first], '--caption', fullCaption, '--allow-direct-publish']
    if (post.kind === 'reel') args.push('--upscale')
    if (post.aiLabel !== false) args.push(AI_LABEL_FLAG)
    if (dryRun && carousel) args.push('--dry-run')
    const stepOf = publishSteps(carousel ? sending.length : 1)
    // Kept in memory only: GET /posts serves this same list, and a write
    // per line would rewrite the queue file dozens of times a minute.
    const result = await execPython(script, args, TIMEOUTS.publish, (line) => {
      const step = stepOf(line)
      if (step !== undefined) post.progress = step
    })
    /*
     * A script that reports its own failure answers {"ok": false, ...} on
     * stdout, which execPython resolves rather than rejects; recording that
     * as published would claim a post that never went out. It is an error,
     * but never retried on its own: nothing proves the script failed before
     * Meta published, and a retry then would put the post out twice.
     */
    if (result?.ok === false) throw new ScriptRefusal(refusalOf(result, message('social.scriptRefused')))
    if (dryRun) {
      post.progress = undefined
      post.status = post.scheduledAt === undefined ? 'draft' : 'scheduled'
      post.updatedAt = new Date().toISOString()
      await postsStore.save()
      return post
    }
    post.status = 'published'
    post.publishedAt = new Date().toISOString()
    post.instagramUrl = readPublishedUrl(result) ?? post.instagramUrl
    clearRetryState(post)
    await queueStoryFor(post)
  } catch (error: unknown) {
    post.status = 'error'
    post.error = error instanceof Error ? error.message : String(error)
    log(`publish failed for ${post.id}: ${post.error}`)
    // A transient failure goes back in line instead of ending here. The
    // status stays `error` so the UI shows what happened; nextAttemptAt is
    // what the scheduler reads to pick it up again. A script's own refusal
    // is final (see above).
    if (error instanceof ScriptRefusal) {
      post.attempts = (typeof post.attempts === 'number' ? post.attempts : 0) + 1
      post.nextAttemptAt = undefined
    } else if (scheduleRetry(post)) {
      log(`post ${post.id} will be retried at ${String(post.nextAttemptAt)} (attempt ${String(post.attempts)} of ${String(PUBLISH_MAX_ATTEMPTS)})`)
    }
  } finally {
    if (marked !== undefined) await marked.cleanup()
  }
  post.progress = undefined
  post.updatedAt = new Date().toISOString()
  await postsStore.save()
  return post
}

/**
 * Publish everything whose time has come.
 *
 * A post is taken only while it is `scheduled`, and moves to `publishing`
 * before the first await, so a tick that overruns the interval cannot send the
 * same post twice. A failure leaves it `error` and the scheduler does not retry
 * on its own, because a broken token would otherwise republish forever.
 *
 * The exception is a failure already judged transient by scheduleRetry: that
 * one carries a nextAttemptAt, and this pass picks it up when the wait is over.
 * A permanent failure has no nextAttemptAt and is never revisited, so the
 * no-republish-forever rule still holds.
 */
export async function runDuePosts(): Promise<void> {
  const now = Date.now()
  for (const post of await postsStore.load()) {
    const retryAt = post.status === 'error' && post.nextAttemptAt !== undefined ? Date.parse(post.nextAttemptAt) : Number.NaN
    const isRetry = !Number.isNaN(retryAt) && retryAt <= now
    if (!isRetry) {
      if (post.status !== 'scheduled' || post.scheduledAt === undefined) continue
      const due = Date.parse(post.scheduledAt)
      if (Number.isNaN(due) || due > now) continue
      log(`scheduled post ${post.id} is due, publishing`)
    } else {
      log(`retrying post ${post.id} (attempt ${String((post.attempts ?? 0) + 1)} of ${String(PUBLISH_MAX_ATTEMPTS)})`)
    }
    await runPublish(post, false)
    // Only the last attempt is announced: an intermediate retry is not news,
    // and hearing about every one of them would train the owner to ignore
    // the notice that matters. A post with no next attempt left is final.
    // (Read through a widening cast: runPublish changed the status in place.)
    if ((post as Post).status === 'error' && post.nextAttemptAt === undefined) await notifyPublishFailure('post', post)
    if ((post as Post).status === 'published') await notifyPublished('post', post, await afterPost(post))
  }
}

/**
 * What follows a published post: the next one due and the story made from it.
 * @param post - the post that just went out.
 * @returns the two moments, when there are.
 */
async function afterPost(post: Post): Promise<{ nextAt?: string; storyAt?: string }> {
  const nextAt = (await postsStore.load())
    .filter(other => other.status === 'scheduled' && typeof other.scheduledAt === 'string')
    .map(other => other.scheduledAt as string)
    .sort()[0]
  const storyAt = (await storiesStore.load()).find(story => story.postId === post.id && story.status === 'scheduled')?.publishAt
  return { ...nextAt === undefined ? {} : { nextAt }, ...storyAt === undefined ? {} : { storyAt } }
}

/**
 * Give a published post its address when the publish itself did not.
 *
 * Meta often has no permalink ready in the seconds after `media_publish`, and
 * the three posts published here before 2026-09-06 have none at all. The
 * comments carry both the post's own caption and its link, so a post can be
 * recognised by the words it went out with — the caption is written once and
 * never edited afterwards, which is what makes it usable as the key.
 * @param seen - the comments a pass read.
 * @returns how many posts were given a link.
 */
export async function reconcilePermalinks(seen: readonly { readonly permalink?: unknown; readonly media_caption?: unknown }[]): Promise<number> {
  const list = await postsStore.load()
  const missing = list.filter(post => post.status === 'published' && post.instagramUrl === undefined && post.caption.length > 12)
  if (missing.length === 0) return 0
  let fixed = 0
  for (const post of missing) {
    const head = post.caption.slice(0, 40)
    const match = seen.find(comment => typeof comment.permalink === 'string' && String(comment.media_caption ?? '').startsWith(head))
    if (match === undefined) continue
    post.instagramUrl = match.permalink as string
    post.updatedAt = new Date().toISOString()
    fixed += 1
  }
  if (fixed > 0) {
    await postsStore.save()
    log(`${String(fixed)} published posts found their link again`)
  }
  return fixed
}

/**
 * Handle the …/social/posts routes: the publication queue.
 *
 * GET    /posts                       list every post, newest first
 * POST   /posts                       queue one (a date makes it scheduled, none a draft)
 * PATCH  /posts/<id>                  edit caption, hashtags, files or date
 * DELETE /posts/<id>                  drop it
 * POST   /posts/<id>/publish          send it now (`?dry=1` rehearses a carousel)
 * POST   /posts/<id>/record-published record a publish made by hand, checked with Meta
 * @param req - incoming request.
 * @param res - server response.
 * @param subpath - the path under /social.
 */
export async function handlePosts(req: IncomingMessage, res: ServerResponse, subpath: string): Promise<void> {
  const list = await postsStore.load()
  await routeCollection<Post>(req, res, subpath, '/posts', {
    notFound: message('social.postNotFound'),
    find: async id => list.find(post => post.id === id),
    // Tagged: the page re-reads the queue every 20 s and an unchanged one
    // answers 304 with no body.
    list: async () => { writeJsonTagged('social-posts', req, res, req.method, JSON.stringify({ ok: true, posts: [...list].reverse() })) },
    create: async () => {
      const input = readPostInput(await readObject(req))
      if (input.files.length === 0) return sendJson(res, 400, { error: message('social.fileRequired') })
      const now = new Date().toISOString()
      const post: Post = {
        id: randomUUID(),
        ...input,
        status: input.scheduledAt === undefined ? 'draft' : 'scheduled',
        createdAt: now,
        updatedAt: now,
      }
      list.push(post)
      await postsStore.save()
      sendJson(res, 200, { ok: true, post })
    },
    actions: {
      // One post, for the publish panel's progress: reading the whole queue
      // every two seconds to follow a single send was wasted work.
      GET: async (_req, _res, post) => { sendJson(res, 200, { ok: true, post }) },
      'POST publish': async (_req, _res, post) => {
        // `?dry=1` rehearses a carousel: the images go to Drive and the child
        // containers are created, but nothing is published and the unused
        // containers expire on their own within a day.
        const dryRun = isDryRun(req)
        // A second click, or a click while the scheduler is sending it, would
        // put the same post out twice.
        if (post.status === 'publishing' || post.status === 'published') {
          return sendJson(res, 409, { error: message(post.status === 'published' ? 'social.postAlreadyPublished' : 'social.publishInProgress') })
        }
        sendJson(res, 200, { ok: true, dryRun, post: await runPublish(post, dryRun) })
      },
      'POST record-published': async (_req, _res, post) => {
        // A post sent by hand — from the UI, from a script, or from this session
        // when the queue itself had failed — leaves no record here, and without
        // one the history shows a failure for something that is live. The PATCH
        // route deliberately refuses to set `published`, because that is the
        // state the queue must not be able to fake; this route is the way in
        // that keeps the guarantee instead of dropping it: it takes the URL and
        // asks Meta whether that media exists on this account before writing.
        const body = await readObject(req)
        const url = typeof body.instagramUrl === 'string' ? body.instagramUrl.trim() : ''
        if (url === '') return sendJson(res, 400, { error: message('social.urlRequired') })
        const mediaId = instagramMediaId(url)
        if (mediaId === undefined) return sendJson(res, 400, { error: message('social.urlNoId', { url }) })
        const check = await verifyMediaOnAccount(mediaId)
        if (!check.ok) return sendJson(res, 400, { error: message('social.metaNotConfirmed', { reason: check.reason }) })
        post.status = 'published'
        post.error = undefined
        clearRetryState(post)
        post.instagramUrl = url
        if (typeof body.publishedAt === 'string' && body.publishedAt !== '') post.publishedAt = body.publishedAt
        else post.publishedAt = (check.timestamp ?? new Date().toISOString()) as string
        post.updatedAt = new Date().toISOString()
        await postsStore.save()
        /*
         * A reel is a reel however it went out: without this, one sent by hand
         * never got the story that follows it a day later, and the gap was
         * invisible — nothing fails, the calendar is simply empty. The call is
         * the same one runPublish makes, so it keeps its own guards: it does
         * nothing for a post that is not a reel, nothing when a story for this
         * post is already queued, and it refuses a clip Meta would reject.
         */
        await queueStoryFor(post)
        sendJson(res, 200, { ok: true, post, verified: check })
      },
      PATCH: async (_req, _res, post) => {
        const body = await readObject(req)
        if (typeof body.caption === 'string') post.caption = body.caption
        if (typeof body.hashtags === 'string') post.hashtags = body.hashtags
        if (Array.isArray(body.files)) post.files = body.files.filter((file): file is string => typeof file === 'string' && file.length > 0)
        if (body.kind === 'photo' || body.kind === 'reel' || body.kind === 'carousel') post.kind = body.kind
        if (body.scheduledAt === null || body.scheduledAt === '') {
          post.scheduledAt = undefined
          if (post.status === 'scheduled') post.status = 'draft'
        } else if (typeof body.scheduledAt === 'string') {
          post.scheduledAt = body.scheduledAt
          // An edited date is a new intention: a post that had failed goes back
          // into the queue rather than staying stuck on its old error.
          if (post.status === 'draft' || post.status === 'error') post.status = 'scheduled'
          clearRetryState(post)
        }
        if (typeof body.aiLabel === 'boolean') post.aiLabel = body.aiLabel
        // A post published by hand, outside this queue, has no record here at
        // all until someone writes one after the fact — and then its real date
        // is the only thing that says when it went out. Nothing else can set
        // it, so the day it happened is editable rather than forever the
        // moment this plugin first heard of the post.
        if (body.publishedAt === null || body.publishedAt === '') {
          post.publishedAt = undefined
        } else if (typeof body.publishedAt === 'string') {
          post.publishedAt = body.publishedAt
        }
        if (typeof body.instagramUrl === 'string') post.instagramUrl = body.instagramUrl
        // `published` is deliberately not reachable here: a post that has gone
        // out is the one state this queue must not be able to fake, and
        // runDuePosts would re-publish anything moved back to `scheduled`.
        if (body.status === 'draft' || body.status === 'scheduled') post.status = body.status
        post.updatedAt = new Date().toISOString()
        await postsStore.save()
        sendJson(res, 200, { ok: true, post })
      },
      DELETE: async (_req, _res, post) => {
        list.splice(list.indexOf(post), 1)
        await postsStore.save()
        sendJson(res, 200, { ok: true })
      },
    },
  })
}
