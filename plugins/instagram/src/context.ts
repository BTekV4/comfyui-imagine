/**
 * What every part of the Instagram publisher shares: the host and config
 * `apply` was given, the folders it works in, the record files on disk (one
 * writer per file, one queue store for posts and stories) and the routing of
 * `/<collection>/<id>/<action>`.
 * @module social/context
 */
import type { NotifyExtra } from '../../../server/src/notify-bus.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonFile, serialized, writeFileAtomic } from '../../../server/vendor/atomic-write/index.ts'
import { safeBasename } from '../../../server/vendor/tool-comfy/gallery.ts'
import { streamText } from '../../../server/vendor/tool-comfy/imagine-models.ts'
import { notAllowed, sendJson } from '../../../server/src/route-kit.ts'
import { message, MESSAGES, type MessageKey } from '../../../server/src/messages.ts'
import type { PluginContext } from '../../../server/src/plugins.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'

/**
 * The folders the publisher works in, as the plugin's settings name them.
 *
 * They used to be constants read at import (`IMAGINE_INSTAGRAM_DIR` and
 * `IMAGINE_SOCIAL_DIR`); a plugin cannot: its settings are the page's, and the
 * module is loaded before any of them is known. Everything that needs a folder
 * asks for it when it uses it.
 */
export interface SocialDirs {
  /** The Instagram project: `config/` with the tokens, `media/`, `state/`. */
  readonly instagramDir: string
  /** Where the Python scripts are. */
  readonly scriptsDir: string
  /** The publisher's records: the queues, the comment record, the rings. */
  readonly stateDir: string
}

/** The parts of the plugin context the publisher calls: the model clients and the log. */
export type SocialHost = Pick<PluginContext, 'llm' | 'auxiliary' | 'log'>

/** One row of the franchise table: a keyword, and the two tags it brings. */
export type FranchiseHashtags = readonly [keyword: string, first: string, second: string]

/**
 * The account's own choices, from the plugin's settings (`manifest.json`
 * holds the defaults), read at every use so a save applies at once.
 */
export interface SocialSettings {
  /** The first day a story may go out (`YYYY-MM-DD`), or undefined for no floor. */
  readonly storiesFrom: () => string | undefined
  /** The local hours a comment pass runs. */
  readonly commentHours: () => readonly number[]
  /** Keyword → franchise hashtags; the first keyword found in the context wins. */
  readonly franchiseHashtags: () => readonly FranchiseHashtags[]
  /**
   * The hashtags every post of this kind starts with: the «fixed» ones, plus
   * the reels' own on a reel. Settings, not code, since 2026-11-13: they name
   * the account, and the plugin is shared.
   */
  readonly fixedHashtags: (type: 'photo' | 'reel') => readonly string[]
  /**
   * Whether what is published carries the mark (empty text: no mark), and
   * the words it says. Read at every publication, like the rest.
   */
  readonly watermarkOn: () => boolean
  readonly watermarkText: () => string
}

/** What `setup` hands the publisher. */
export interface SocialConfig {
  /**
   * The models, read per call so a save on the settings page (Instagram
   * models) reaches the next call without a restart. `text` falls back to
   * `vision`; without a `vision` route the passes are skipped and the
   * templates apply.
   */
  readonly models: { readonly vision: () => ModelRoute | undefined; readonly text: () => ModelRoute | undefined }
  /** The folder the gallery serves (settings-page override included). */
  readonly mediaDir: string
  /** Whether the scheduler may publish, read at every tick. */
  readonly schedulerOn: () => boolean
  /** One Telegram notice to the owner; never throws. */
  readonly notify: (text: string, extra?: NotifyExtra) => Promise<void>
  /** The account's settings. */
  readonly settings: SocialSettings
}

let current: { readonly host: SocialHost; readonly config: SocialConfig; readonly dirs: SocialDirs } | undefined

/** Record what `setup` was given. */
export function setSocialContext(host: SocialHost, config: SocialConfig, dirs: SocialDirs): void {
  current = { host, config, dirs }
}

function context(): { readonly host: SocialHost; readonly config: SocialConfig; readonly dirs: SocialDirs } {
  if (current === undefined) throw new Error('social: apply not called')
  return current
}

/** The model clients of the plugin context. */
export const socialHost = (): SocialHost => context().host

/**
 * One line in the host's log, through the plugin context (`[plugin:instagram]`);
 * before `setup` (a test calling a module directly) it still goes to the console.
 * @param line - what to write.
 */
export function log(line: string): void {
  if (current === undefined) console.log(`[plugin:instagram] ${line}`)
  else current.host.log(line)
}

/** An error as one line of text, for {@link log}. */
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The account's settings, as they are now. */
export const socialSettings = (): SocialSettings => context().config.settings

/** The comment hours used when the setting is empty or names no valid hour. */
export const DEFAULT_COMMENT_HOURS: readonly number[] = [8, 14, 20]

/**
 * The comment hours a setting names: integers 0-23 separated by commas or
 * spaces, deduplicated and sorted.
 * @param text - the setting as written (`8, 14, 20`).
 * @returns the hours, or {@link DEFAULT_COMMENT_HOURS} when none is valid.
 */
export function parseCommentHours(text: string): readonly number[] {
  const hours = new Set<number>()
  for (const part of text.split(/[\s,;]+/)) {
    if (!/^\d{1,2}$/.test(part)) continue
    const hour = Number(part)
    if (hour >= 0 && hour <= 23) hours.add(hour)
  }
  return hours.size === 0 ? DEFAULT_COMMENT_HOURS : [...hours].sort((a, b) => a - b)
}

/**
 * The first story day a setting names.
 * @param text - the setting as written (`2026-09-14`), empty for no floor.
 * @returns the day, or undefined when the setting is empty or not a date.
 */
export function parseStoriesFrom(text: string): string | undefined {
  const day = text.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00`)) ? day : undefined
}

/**
 * The franchise table a setting writes: entries separated by `;` or new
 * lines, each `keyword: #First #Second` (`sailor moon: #SailorMoon
 * #SailorMoonCosplay`). The keyword is matched case-insensitively; an entry
 * without a keyword or without two tags is skipped.
 * @param text - the setting as written.
 * @returns the rows, in their order.
 */
export function parseFranchiseHashtags(text: string): readonly FranchiseHashtags[] {
  const rows: FranchiseHashtags[] = []
  for (const entry of text.split(/[;\n]+/)) {
    const cut = entry.indexOf(':')
    if (cut <= 0) continue
    const keyword = entry.slice(0, cut).trim().toLowerCase()
    const tags = entry.slice(cut + 1).trim().split(/\s+/).filter(tag => /^#[\p{L}\p{N}_]+$/u.test(tag))
    const [first, second] = tags
    if (keyword === '' || first === undefined || second === undefined) continue
    rows.push([keyword, first, second])
  }
  return rows
}

/**
 * A row of hashtags as the settings page holds it.
 * @param text - the tags, separated by spaces, commas or semicolons; the `#` may be left out.
 * @returns the valid tags, in order, without duplicates (case aside).
 */
export function parseHashtagList(text: string): readonly string[] {
  const tags: string[] = []
  for (const raw of text.split(/[\s,;]+/)) {
    if (raw === '') continue
    const tag = raw.startsWith('#') ? raw : `#${raw}`
    if (!/^#[\p{L}\p{N}_]+$/u.test(tag)) continue
    if (!tags.some(known => known.toLowerCase() === tag.toLowerCase())) tags.push(tag)
  }
  return tags
}

/** Send one Telegram notice (the host's `notify`, which never throws). */
export const notify = (text: string, extra?: NotifyExtra): Promise<void> => context().config.notify(text, extra)

/**
 * Whether a recorded error carries one of the plugin's own sentences, in
 * either language: its text up to the first placeholder, case aside.
 *
 * A post's error is stored in whichever language wrote it — the page's, for
 * a publication sent by hand, the «language» setting's for the scheduler —
 * and the retry and the notice's hint read it back later: matching one
 * language only would make an English failure look like a new one.
 * @param text - the recorded error.
 * @param keys - the sentences to look for.
 * @returns true when one of them is in the text.
 */
export function carries(text: string, ...keys: readonly MessageKey[]): boolean {
  const lower = text.toLowerCase()
  return keys.some(key => [MESSAGES[key].it, MESSAGES[key].en].some(sentence => {
    const opening = (sentence.split('{')[0] ?? '').toLowerCase()
    return opening.length >= 6 && lower.includes(opening)
  }))
}

/** Whether the scheduler may publish right now. */
export const schedulerOn = (): boolean => context().config.schedulerOn() === true

/** One `{ provider, model }` route, or undefined when either is missing. */
function routeOf(value: unknown): ModelRoute | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const { provider, model } = value as { provider?: unknown; model?: unknown }
  return typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '' ? { provider, model } : undefined
}

/** The routes in force right now (read per call: the fields are volatile). */
export function currentRoutes(): { readonly vision?: ModelRoute; readonly text?: ModelRoute } {
  const { models } = context().config
  return { vision: routeOf(models.vision()), text: routeOf(models.text()) }
}

/**
 * Run one text-only call on the text model.
 *
 * The same route the caption writer uses. No deadline of its own: a shared
 * backend plus a thinking model means a pass can legitimately wait minutes
 * for its first token, and the only bound is the silence clock in the model
 * client (`server/src/llm.ts`), which gives up a connection that stops
 * sending bytes. `hooks.signal` ends the call from outside.
 *
 * Until 2026-10-25 this read the model off `ctx.get('llm')`, which the host
 * no longer had after the old host context went: every caption fell back to the
 * templates and every comment pass wrote no reply.
 * @param instruction - the whole prompt.
 * @param hooks - optional abort signal and progress observers.
 * @returns the model's reply, or undefined if it is unavailable or failed.
 */
export async function askModel(
  instruction: string,
  hooks?: { readonly signal?: AbortSignal },
): Promise<string | undefined> {
  const target = currentRoutes().text
  if (target === undefined) return undefined
  return streamText(socialHost().llm, target, instruction, hooks)
}

/* ------------------------------------------------------------------ folders */

/** Base path of the Instagram project (scripts, config, state). */
export const instagramDir = (): string => context().dirs.instagramDir

/** Where the Python scripts are. */
export const scriptsDir = (): string => context().dirs.scriptsDir

/**
 * Where the reel publisher leaves its Meta-ready master.
 *
 * A story is the same clip as the reel, and Instagram wants it conformed the
 * same way; the reel's preflight has already produced that file, so the story
 * uses it rather than re-encoding the raw render.
 */
export const normalizedDir = (): string => join(instagramDir(), 'media', 'normalized')

/** Path to the config directory (the Graph token and the Facebook one). */
export const configDir = (): string => join(instagramDir(), 'config')

/**
 * Where the publisher's own records live: the queues, the comment record,
 * the caption style examples and the rings of captions and replies already
 * written.
 */
export const stateDir = (): string => context().dirs.stateDir

/** The media folder the gallery serves. */
export const mediaDir = (): string => context().config.mediaDir

/**
 * Resolve a gallery name to a readable file under the media directory.
 * Rejects anything that escapes it, since the name arrives from the client.
 * @param name - the gallery item name.
 * @returns the absolute path, or undefined when it is not a readable file.
 */
export async function resolveMediaPath(name: string | undefined): Promise<string | undefined> {
  const safe = name === undefined ? undefined : safeBasename(name)
  if (safe === undefined) return undefined
  const path = join(mediaDir(), safe)
  try {
    return (await stat(path)).isFile() ? path : undefined
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------ record files */

/**
 * One JSON record on disk, written whole and one change at a time.
 *
 * A plain writeFile opens the target with O_TRUNC: the old copy is destroyed
 * before the new bytes land, so a write that fails — ENOSPC, EDQUOT, a killed
 * process — leaves an empty file and the queue is gone at the next restart.
 * writeFileAtomic writes a sibling and renames it over the target instead,
 * and `serialized` keeps two writes from interleaving.
 *
 * The error is kept rather than swallowed: the queue still runs from memory
 * for this session, but a restart would lose it, so …/social/status reports it.
 */
export interface RecordFile {
  readonly path: string
  /** The last error a write hit, or undefined once a write succeeds. */
  readonly error: string | undefined
  /** Write the value as it is when the write runs; never rejects. */
  save(): Promise<void>
}

export function recordFile(path: string | (() => string), label: string, value: () => unknown): RecordFile {
  let lastError: string | undefined
  const file = typeof path === 'string' ? (): string => path : path
  return {
    get path() { return file() },
    get error() { return lastError },
    save: () => serialized(file(), async () => {
      await writeFileAtomic(file(), JSON.stringify(value(), null, 1), { mode: 0o644 })
      lastError = undefined
    }).catch((error: unknown) => {
      lastError = `${label} not written (${error instanceof Error ? error.message : String(error)})`
      log(`could not write the ${label} record: ${lastError}`)
    }),
  }
}

/**
 * A queue (posts, stories), held in memory and written through on every
 * change.
 *
 * One process owns the file, so the list is the authority and the file is its
 * record. Until 2026-10-25 posts and stories each had their own copy of this.
 */
export interface QueueStore<T> {
  /** The last write error, or undefined. */
  readonly error: string | undefined
  /** The entries, read from disk once and then served from memory, oldest first. */
  load(): Promise<T[]>
  /** Write the queue out. */
  save(): Promise<void>
}

export function queueStore<T extends { readonly id: string }>(file: string, label: string): QueueStore<T> {
  let entries: T[] | undefined
  let loading: Promise<T[]> | undefined
  const record = recordFile(() => join(stateDir(), file), label, () => entries ?? [])
  return {
    get error() { return record.error },
    load() {
      if (entries !== undefined) return Promise.resolve(entries)
      // One read even when two requests ask before it lands: two reads would
      // hand out two arrays, and a change to the one dropped would be lost.
      loading ??= readJsonFile(record.path).then(parsed => {
        entries = Array.isArray(parsed)
          ? parsed.filter((entry): entry is T => entry !== null && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string')
          : []
        return entries
      })
      return loading
    },
    save: () => record.save(),
  }
}

/* ---------------------------------------------------- recent captions/replies */

/** How many past captions (or replies) the writer is told not to repeat. */
const RECENT_KEEP = 30

/**
 * Read a JSON array of captions, tolerating a missing or broken file.
 * @param path - the file to read.
 * @param limit - how many entries to keep, from the end.
 * @returns the captions, newest last.
 */
export async function readRecent(path: string, limit: number): Promise<string[]> {
  const parsed = await readJsonFile(path)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(-limit)
}

/**
 * Remember one caption or reply so the next ones are told not to repeat it.
 *
 * Never throws: a history that cannot be written costs variety, not the post
 * or the reply, which is already in hand.
 * @param path - the ring file.
 * @param text - the text just used.
 * @param what - its name in the log line.
 */
export async function rememberRecent(path: string, text: string, what: string): Promise<void> {
  try {
    await serialized(path, async () => {
      const kept = [...await readRecent(path, RECENT_KEEP), text].slice(-RECENT_KEEP)
      await writeFileAtomic(path, JSON.stringify(kept, null, 1), { mode: 0o644 })
    })
  } catch (error: unknown) {
    log(`could not record the ${what}: ${errorText(error)}`)
  }
}

/* ----------------------------------------------------------------- routing */

/** A handler of one entry's action. */
export type EntryAction<T> = (req: IncomingMessage, res: ServerResponse, entry: T) => Promise<void>

/**
 * The routes of one collection under /social: the list itself, then one
 * entry by id and what to do with it.
 *
 *     GET|POST /<name>                 list, create
 *     <special>  /<name>/<word>        before the lookup (`POST run`)
 *     <METHOD>   /<name>/<id>[/<act>]  `actions['METHOD act']` or `actions.METHOD`
 *
 * Posts, stories and comments each walked this by hand until 2026-10-25.
 */
export interface CollectionRoutes<T> {
  readonly list: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  readonly create?: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  readonly special?: Readonly<Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>>
  readonly find: (id: string | undefined) => Promise<T | undefined>
  readonly notFound: string
  readonly actions: Readonly<Record<string, EntryAction<T>>>
}

/**
 * Answer one request under a collection.
 * @param req - the request.
 * @param res - the response.
 * @param subpath - the path under /social, e.g. `/posts/<id>/publish`.
 * @param name - the collection's segment, e.g. `/posts`.
 * @param routes - what it serves.
 */
export async function routeCollection<T>(
  req: IncomingMessage,
  res: ServerResponse,
  subpath: string,
  name: string,
  routes: CollectionRoutes<T>,
): Promise<void> {
  const method = req.method?.toUpperCase()
  const rest = subpath.slice(name.length)
  if (rest === '' || rest === '/') {
    if (method === 'GET') return routes.list(req, res)
    if (method === 'POST' && routes.create !== undefined) return routes.create(req, res)
    notAllowed(res, routes.create === undefined ? 'GET' : 'GET, POST')
    return
  }
  const [, id, action] = rest.split('/')
  const special = routes.special?.[`${String(method)} ${String(id)}`]
  if (special !== undefined) return special(req, res)
  const entry = await routes.find(id)
  if (entry === undefined) {
    sendJson(res, 404, { error: routes.notFound })
    return
  }
  const handler = routes.actions[action === undefined ? String(method) : `${String(method)} ${action}`]
  if (handler !== undefined) return handler(req, res, entry)
  // The methods this entry's path does answer: none means the path itself is unknown.
  const allowed = Object.keys(routes.actions)
    .map(key => key.split(' '))
    .filter(([, act]) => act === action)
    .map(([verb = '']) => verb)
  if (allowed.length === 0) {
    sendJson(res, 404, { error: message('route.unknown', { method: String(method), path: subpath }) })
    return
  }
  notAllowed(res, allowed.join(', '))
}

/** Whether `?dry=1` asks for a rehearsal. */
export const isDryRun = (req: IncomingMessage): boolean => new URL(req.url ?? '/', 'http://x').searchParams.get('dry') === '1'
