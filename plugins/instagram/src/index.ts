/**
 * Instagram publishing for the Imagine host: wraps the Python publishing
 * scripts (an external requirement, see README.md) with HTTP routes for
 * gallery integration, and runs the scheduler that publishes the queue, one
 * story a day and the comment passes.
 *
 * Routes, all under `/plugin/instagram/social` (publishing itself goes through
 * the queue, `/posts`; the direct publish-photo/-reel/-carousel routes nothing
 * called were removed on 2026-10-20):
 *   POST /caption-preview — generate caption+hashtag preview
 *   GET  /status          — check token and connectivity
 *   GET  /token           — both tokens' state, masked (never a token)
 *   POST /token           — paste a new Instagram access token
 *   POST /facebook-token  — paste the comment pass's page/user tokens
 *   GET  /facebook-token/check — ask Meta whether those tokens still work
 *   GET  /posts           — the publication queue
 *   GET  /comments        — comments read, liked and replied to
 *   GET  /stories         — the story queue, one a day
 *
 * The scheduler is the plugin API's `tick`, every 30 s, and does anything only
 * while the plugin's `scheduler` setting is on. Leave it off wherever another
 * system publishes the same queue: running both would publish it twice.
 *
 * TypeScript since 2026-10-25: until then this was one 2500-line file of
 * compiled JavaScript, corrected by hand.
 * @module social
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { readObject, restOf, sendJson } from '../../../server/src/route-kit.ts'
import { handleCaptionPreview } from './captions.ts'
import { handleComments, runDueCommentPass } from './comments.ts'
import { runDueInsights } from './insights.ts'
import { runWatch } from './watch.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
import {
  parseCommentHours, parseFranchiseHashtags, parseHashtagList, parseStoriesFrom, schedulerOn, setSocialContext,
  type SocialConfig, type SocialDirs,
} from './context.ts'
import { withLanguage } from '../../../server/src/messages.ts'
import type { PluginContext, PluginSetup, PluginStatus, PluginStatusLine } from '../../../server/src/plugins.ts'
import { checkFacebookTokens } from './token-check.ts'
import { readFacebookTokenState, readTokenState, saveAccessToken, saveFacebookTokens } from './token.ts'
import { handlePosts, postsStore, runDuePosts } from './posts.ts'
import { handleStories, runDueStories, storiesStore } from './stories.ts'

/**
 * Where the publisher's routes live.
 *
 * They were the host's `/social` until Instagram became a plugin (2026-11-06):
 * a plugin owns `/plugin/<id>/` and nothing else, and the client asks for
 * `/plugin/instagram/social/...` now.
 */
const ROUTE_PREFIX = '/plugin/instagram/social'

/**
 * Handle GET …/social/status
 *
 * Returns the current status of the Instagram integration:
 * - token presence
 * - last publication timestamp, from the queue
 * - the last error a queue write hit
 */
async function handleStatus(res: ServerResponse): Promise<void> {
  /*
   * The token is read from its module, masked: `…/social/status` has always
   * said whether the token is there, and since 2026-11-06 it also says whom it
   * belongs to and how long it has left — without the value, which must not
   * leave this place.
   */
  const token = await readTokenState()
  const hasToken = token.hasToken
  // The queue is the record of what went out. The scripts' own SQLite
  // database this used to read is not written here (the scripts only touch it
  // with --pin), and the query ran `python3 python3 -c …`, so it never answered.
  const lastPublished = (await postsStore.load())
    .map(post => post.status === 'published' && typeof post.publishedAt === 'string' ? post.publishedAt : undefined)
    .filter((at): at is string => at !== undefined)
    .sort()
    .pop()
  sendJson(res, 200, {
    ok: true,
    hasToken,
    token,
    /*
     * The two comment tokens travel in the same read: the settings page draws
     * two blocks side by side, and a second request for each would only be
     * one more thing to keep in sync.
     */
    facebook: await readFacebookTokenState(),
    lastPublished: lastPublished ?? null,
    // A queue that could not be written only survives in memory: the next
    // restart loses every scheduled post. Reporting it here is what turns
    // that silent loss into something the operator can see before it bites.
    queueWriteError: { posts: postsStore.error ?? null, stories: storiesStore.error ?? null },
  })
}

/**
 * GET …/social/token reads the token's state; POST …/social/token replaces the
 * token.
 *
 * The write is deliberately narrow: the body carries the token, and at most the
 * lifetime and the account name. Every other key in the file — the ids, the
 * permissions, the notes on how it was obtained — is copied through, because an
 * external OAuth flow owns that file and would otherwise lose them.
 *
 * Neither answer carries the token, and neither is cached: the page must not be
 * able to read back what was pasted.
 * @param req - the request.
 * @param res - the response.
 */
async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'POST') {
    sendJson(res, 200, { ...await readTokenState(), facebook: await readFacebookTokenState() })
    return
  }
  try {
    const body = await readObject<{ accessToken?: unknown; expiresIn?: unknown; username?: unknown }>(req, 16 * 1024)
    const update = {
      accessToken: typeof body.accessToken === 'string' ? body.accessToken : '',
      ...typeof body.expiresIn === 'number' ? { expiresIn: body.expiresIn } : {},
      ...typeof body.username === 'string' && body.username.trim() !== '' ? { username: body.username } : {},
    }
    const saved = await saveAccessToken(update)
    sendJson(res, 200, { ok: true, backup: saved.backup, token: saved.state })
  } catch (error: unknown) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * POST …/social/facebook-token replaces either or both of the comment tokens.
 *
 * The comment script replies with `page_access_token` and falls back to
 * `user_access_token`, so both are writable and only the ones in the body are
 * touched: `page_id`, `fb_user_id`, `page_name`, `permissions`, `source` and
 * `note` belong to the exchange that produced them and would be lost if the
 * file were rewritten whole.
 *
 * The answer carries the masked state, never a token, and is not cached.
 * @param req - the request.
 * @param res - the response.
 */
async function handleFacebookToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('cache-control', 'no-store')
  try {
    const body = await readObject<{ pageAccessToken?: unknown; userAccessToken?: unknown; expiresIn?: unknown }>(req, 16 * 1024)
    const saved = await saveFacebookTokens({
      ...typeof body.pageAccessToken === 'string' ? { pageAccessToken: body.pageAccessToken } : {},
      ...typeof body.userAccessToken === 'string' ? { userAccessToken: body.userAccessToken } : {},
      ...typeof body.expiresIn === 'number' ? { expiresIn: body.expiresIn } : {},
    })
    sendJson(res, 200, { ok: true, backup: saved.backup, facebook: saved.state })
  } catch (error: unknown) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * GET …/social/facebook-token/check asks Meta whether the two comment tokens are
 * still good.
 *
 * On request, never while drawing the page: the page must not need the network
 * to say what it knows. Meta's silence is not the page's error, so an unreachable
 * Meta is a 200 with `verdict: "unknown"` and the reason — the page shows it in
 * grey, without pretending the tokens are broken.
 * @param res - the response.
 */
async function handleFacebookTokenCheck(res: ServerResponse): Promise<void> {
  res.setHeader('cache-control', 'no-store')
  sendJson(res, 200, await checkFacebookTokens())
}

/**
 * Route one request under the plugin's prefix.
 *
 * The language of the page is put on the response by the host; the bundle has
 * its own copy of `messages.ts`, whose `currentLanguage()` reads its own
 * `AsyncLocalStorage` — so it is set here, from the response, or every composed
 * error would come out in Italian on an English page.
 */
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const language = (res as ServerResponse & { language?: string }).language
  await withLanguage(language, () => routeUnder(req, res))
}

/** The dispatch, once the language is in place. */
async function routeUnder(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rest = restOf(req, res, ROUTE_PREFIX)
  if (rest === undefined) return
  const subpath = `/${rest}`
  const method = req.method?.toUpperCase()
  const under = (name: string): boolean => subpath === name || subpath.startsWith(`${name}/`)
  if (under('/stories')) return handleStories(req, res, subpath)
  if (under('/comments')) return handleComments(req, res, subpath)
  if (under('/posts')) return handlePosts(req, res, subpath)
  if (method === 'POST' && subpath === '/caption-preview') return handleCaptionPreview(req, res)
  if (method === 'GET' && subpath === '/status') return handleStatus(res)
  if (subpath === '/token' && (method === 'GET' || method === 'POST')) return handleToken(req, res)
  if (subpath === '/facebook-token' && method === 'POST') return handleFacebookToken(req, res)
  if (subpath === '/facebook-token/check' && method === 'GET') return handleFacebookTokenCheck(res)
  sendJson(res, 404, { error: `Unknown route: ${String(method)} ${ROUTE_PREFIX}${subpath}` })
}

/**
 * The plugin's entry point: the publisher, handed the plugin's context.
 *
 * The folders and the account's choices (the story hand-over day, the comment
 * hours, the franchise hashtags) come from the settings, read at every use so
 * a save on the page applies without a reload. The routes and the scheduler
 * go through the plugin API: `routes`, and `tick` on the host's one timer
 * (until 2026-11-07 the plugin ran its own interval behind an adapter that
 * rebuilt the old host context).
 * @param host - the plugin context.
 * @returns the routes, the tick and the status the panel shows.
 */
export default function setup(host: PluginContext): PluginSetup {
  /** One setting as a trimmed string. */
  const setting = (key: string): string => String(host.config()[key] ?? '').trim()
  /** The model: the plugin's own, or the one the studio's page names. */
  const modelRoute = (): ModelRoute => {
    const written = setting('model')
    const cut = written.indexOf('/')
    return cut > 0 && cut < written.length - 1
      ? { provider: written.slice(0, cut), model: written.slice(cut + 1) }
      : host.model()
  }
  /*
   * The folders are settings: getters, not values, because a change from the
   * page must apply from the next call (and the state folder holds the
   * queues: moving it halfway would mean losing the queue).
   */
  const dirs: SocialDirs = {
    get instagramDir() { return setting('instagramDir') || host.dataPath('instagram') },
    get scriptsDir() { return setting('scriptsDir') || join(dirs.instagramDir, 'scripts') },
    get stateDir() { return setting('stateDir') || host.dataPath('social') },
  }
  const config: SocialConfig = {
    // One model for both passes: the studio names a single one since 2026-10-31.
    models: { text: modelRoute, vision: modelRoute },
    mediaDir: host.mediaDir,
    schedulerOn: () => host.config().scheduler === true,
    notify: (text, extra) => host.notify(text, extra),
    settings: {
      storiesFrom: () => parseStoriesFrom(setting('storiesFrom')),
      commentHours: () => parseCommentHours(setting('commentHours')),
      franchiseHashtags: () => parseFranchiseHashtags(setting('franchiseHashtags')),
      fixedHashtags: (type) => {
        const all = parseHashtagList(setting('fixedHashtags'))
        if (type === 'photo') return all
        const more = parseHashtagList(setting('reelHashtags'))
        return [...all, ...more.filter(tag => !all.some(known => known.toLowerCase() === tag.toLowerCase()))]
      },
      // The mark on published files (2026-11-11): the toggle's value arrives
      // as a boolean, so it is read there and not through `setting`.
      watermarkOn: () => host.config().watermark !== false,
      // Empty means no mark: the account's name lives in its settings, not here.
      watermarkText: () => setting('watermarkText'),
    },
  }
  setSocialContext({ llm: host.llm, auxiliary: host.auxiliary, log: line => { host.log(line) } }, config, dirs)
  /*
   * The host ticks every 30 s and does not wait for a tick to settle, so a
   * tick still running (a comment pass takes minutes) makes the next ones
   * return at once instead of starting a second publish beside it.
   */
  let ticking = false
  const tick = async (): Promise<void> => {
    if (!schedulerOn() || ticking) return
    ticking = true
    // One tick does both, in sequence: a comment pass takes minutes, and
    // running it beside a publish would have two long Python calls fighting
    // over the same Graph token.
    /*
     * What the scheduler writes on its own — the owner's notices, a scheduled
     * post's progress and error, the comment pass's notes — has no page to
     * take the language from: it takes the «language» setting (Italian by
     * default, as before the setting existed).
     */
    try {
      await withLanguage(setting('language') || 'it', async () => {
        await runDuePosts()
        await runDueStories()
        await runDueCommentPass()
        // Last: a report a day old is never urgent, and it reads Meta only
        // every ten minutes whatever the tick rate.
        await runDueInsights()
        await runWatch()
      })
    } catch (error: unknown) {
      host.log(`scheduler tick failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    } finally {
      ticking = false
    }
  }
  return {
    // Async on purpose: whatever throws — a body the host's reader refuses, a
    // record it cannot write — reaches the host router, which answers it with
    // the error's own status (400, 413) or a 500. A path that cannot be
    // decoded is answered by `restOf` with a 400.
    routes: [{ kind: 'prefix', path: ROUTE_PREFIX, handler: route }],
    tick,
    status: () => statusOf(),
  }
}

/**
 * What the panel says about Instagram and the comments.
 *
 * Nothing here goes to the network: `status()` has two seconds and is asked
 * every time the page loads, so it reports what the files say (which account,
 * how many days the token has, whether the comment tokens are there and what
 * expiry the exchange recorded) — the check against Meta stays a button.
 * @returns the status, with one line per thing worth knowing.
 */
async function statusOf(): Promise<PluginStatus> {
  const token = await readTokenState()
  const comments = await readFacebookTokenState()
  const lines: PluginStatusLine[] = []
  const days = token.expiresInDays
  const account = `@${token.username ?? '?'}`
  // The account and the token's days: the first line, and the summary beside the name.
  const accountLine = days === null
    ? { en: `${account} · expiry not recorded`, it: `${account} · scadenza non registrata` }
    : { en: `${account} · ${String(days)} days`, it: `${account} · ${String(days)} giorni` }
  if (token.hasToken) {
    lines.push({
      text: accountLine,
      tone: token.expired ? 'bad' : token.expiringSoon ? 'warn' : 'ok',
    })
  } else {
    lines.push({
      text: { en: 'no Instagram token: it cannot publish', it: 'token Instagram mancante: non si pubblica' },
      tone: 'bad',
    })
  }
  const page = comments.hasPageToken ? '✓' : '—'
  const user = comments.hasUserToken ? '✓' : '—'
  if (comments.hasToken) {
    const when = comments.expiresAt === null
      ? { en: 'no expiry recorded', it: 'scadenza non registrata' }
      : {
          en: `recorded expiry ${new Date(comments.expiresAt).toLocaleDateString('en-GB')}`,
          it: `scadenza registrata ${new Date(comments.expiresAt).toLocaleDateString('it-IT')}`,
        }
    lines.push({
      text: { en: `comments: page ${page}, user ${user} · ${when.en}`, it: `commenti: pagina ${page}, utente ${user} · ${when.it}` },
      tone: comments.expired ? 'warn' : 'ok',
    })
  } else {
    lines.push({
      text: { en: 'no comment tokens: no replies to comments', it: 'token dei commenti mancanti: nessuna risposta ai commenti' },
      tone: 'warn',
    })
  }
  lines.push({
    text: scheduling(),
    tone: schedulerOn() ? 'ok' : 'muted',
  })
  return {
    ok: token.hasToken,
    summary: token.hasToken ? accountLine : { en: 'token missing', it: 'token mancante' },
    lines,
  }
}

/** The scheduler line, in the two languages. */
function scheduling(): { en: string; it: string } {
  return schedulerOn()
    ? { en: 'automatic publishing on', it: 'pubblicazione automatica attiva' }
    : { en: 'automatic publishing off', it: 'pubblicazione automatica spenta' }
}
