/**
 * The Meta Graph tokens behind the Instagram integration: the state the settings
 * page reads, and how a new one is put in place.
 *
 * Two files, both written by external OAuth flows:
 * `api_token.json` publishes and answers comments (the Instagram-Login token,
 * one file) and `facebook_comments_token.json` is what the comment passes use to
 * read and like comments — a **user** token and its **page** token, and the
 * script replies with the page one.
 *
 * `config/api_token.json` is not this app's file: an external OAuth flow (the
 * token generator dashboard) writes it, and beside `access_token` it carries
 * the ids, the granted permissions, the account type and the notes on how the
 * token was obtained. A save therefore replaces the token — plus `obtained`,
 * and `expires_in` when one is passed — and copies every other key through
 * untouched, after keeping a dated copy of the file.
 *
 * The token itself never leaves this module: what the page reads is the account
 * name, the last four digits of the id and the days left. A token that has run
 * out is reported before the scheduler finds out on its own.
 * @module social/token
 */
import { copyFile, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readJsonFile, serialized, writeFileAtomic } from '../../../server/vendor/atomic-write/index.ts'
import { message } from '../../../server/src/messages.ts'
import { configDir } from './context.ts'

/** The file the OAuth flow writes: the token and what it says about itself. */
export const TOKEN_FILE = 'api_token.json'

/**
 * The second file: the Facebook user and page tokens the comment passes use.
 *
 * Not a copy of the first: it is exchanged from a Facebook Login session, it
 * carries the page and the account ids beside the two tokens, and the comment
 * script replies with `page_access_token` and falls back to
 * `user_access_token`.
 */
export const COMMENTS_TOKEN_FILE = 'facebook_comments_token.json'

/**
 * The prefix of a Facebook-Login token: `E` followed by `AA`.
 *
 * Read off the live file on 2026-11-06 (192 and 209 characters for the user and
 * the page token): an Instagram-Login token pasted in the wrong box starts with
 * the other prefix, and the exchange would fail with a 190 much later. Composed
 * in two pieces for the same reason as {@link TOKEN_PREFIX}: this repository
 * publishes itself.
 */
const FACEBOOK_PREFIX = ['E', 'AA'].join('')

/** How many older copies of the token file to keep beside it. */
const KEPT_BACKUPS = 5

/**
 * The prefix of a long-lived Instagram-Login token: `IG` followed by `AA`.
 *
 * Read off the live file on 2026-11-06 (159 characters, that prefix): a token
 * of another form is almost certainly pasted from the wrong dashboard, and the
 * publisher would fail with a 190 instead of a save that says why.
 *
 * Built at run time on purpose: this repository publishes itself and its
 * plugin bundles are committed, and a `grep` for the head of a token must find
 * nothing there. A literal `a + b` would be folded into one string by the
 * bundler; an array joined at run time is not.
 */
const TOKEN_PREFIX = ['IG', 'AA'].join('')

/** A Graph token is a few hundred characters: these bounds catch a paste of the wrong thing. */
const MIN_TOKEN_LENGTH = 40
const MAX_TOKEN_LENGTH = 4096

/** The longest lifetime Meta issues is 60 days; anything past a year is a mistake. */
const MAX_EXPIRES_IN = 366 * 24 * 60 * 60

/** How close to expiry the page starts warning. */
export const EXPIRING_SOON_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * What the settings page may know about the token: never the token itself.
 *
 * `expiresInDays` is negative once the token has run out, and `null` when the
 * file does not say when it expires — an unknown is not the same as expired.
 */
export interface TokenState {
  readonly hasToken: boolean
  readonly username: string | null
  readonly accountType: string | null
  /** The last four digits of `ig_user_id`, enough to tell two accounts apart. */
  readonly igUserIdTail: string | null
  readonly obtained: string | null
  readonly expiresAt: string | null
  readonly expiresInDays: number | null
  readonly expiringSoon: boolean
  readonly expired: boolean
}

/** A new token, as the route receives it. */
export interface TokenUpdate {
  readonly accessToken: string
  /** Lifetime in seconds; absent, the file keeps the one it has. */
  readonly expiresIn?: number
  /** The account the token belongs to, when it is known; absent, untouched. */
  readonly username?: string
}

/** What a save leaves behind. */
export interface TokenUpdateResult {
  readonly state: TokenState
  /** The dated copy of the file, or null when there was no file to copy. */
  readonly backup: string | null
}

/** One field of the token file, when it is a non-empty string. */
function textOf(config: Record<string, unknown>, key: string): string | null {
  const value = config[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** A token file as an object, or an empty one when it is missing or unusable. */
async function readConfig(dir: string, file: string = TOKEN_FILE): Promise<Record<string, unknown>> {
  const raw = await readJsonFile(join(dir, file), '[social]')
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
}

/**
 * The token's state, masked.
 *
 * The expiry is computed from `obtained` + `expires_in` rather than read off a
 * field: the file has no expiry date of its own, and the two fields are what
 * the OAuth flow writes.
 * @param dir - the config directory; the live one by default.
 * @returns the masked state.
 */
export async function readTokenState(dir: string = configDir()): Promise<TokenState> {
  const config = await readConfig(dir)
  const token = textOf(config, 'access_token')
  const obtained = textOf(config, 'obtained')
  const expiresIn = typeof config['expires_in'] === 'number' && config['expires_in'] > 0 ? config['expires_in'] : null
  const obtainedAt = obtained === null ? Number.NaN : Date.parse(obtained)
  const expiresAtMs = Number.isNaN(obtainedAt) || expiresIn === null ? null : obtainedAt + expiresIn * 1000
  const expiresInDays = expiresAtMs === null ? null : Math.floor((expiresAtMs - Date.now()) / DAY_MS)
  const igUserId = textOf(config, 'ig_user_id')
  return {
    hasToken: token !== null,
    username: textOf(config, 'username'),
    accountType: textOf(config, 'account_type'),
    igUserIdTail: igUserId === null ? null : igUserId.slice(-4),
    obtained: Number.isNaN(obtainedAt) ? null : new Date(obtainedAt).toISOString(),
    expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
    expiresInDays,
    expiringSoon: expiresInDays !== null && expiresInDays >= 0 && expiresInDays <= EXPIRING_SOON_DAYS,
    expired: expiresInDays !== null && expiresInDays < 0,
  }
}

/**
 * Check a pasted token's shape before anything is written.
 *
 * Held to what the live file looks like: the prefix of a long-lived
 * Instagram-Login token, no whitespace (a copied line often carries a newline),
 * and a length a token could plausibly have. Nothing about the value is
 * echoed back in the refusal.
 * @param value - what the page sent.
 * @returns the trimmed token.
 * @throws {Error} when the shape is wrong.
 */
export function checkAccessToken(value: unknown): string {
  const token = typeof value === 'string' ? value.trim() : ''
  if (token === '') throw new Error(message('social.tokenEmpty'))
  if (/\s/.test(token)) throw new Error(message('social.tokenWhitespace'))
  /*
   * The prefix before the length: a value pasted from another dashboard is
   * short, and saying "must start with the prefix" is the sentence that shows
   * where to take it from (the full message names the prefix, but on the
   * page, not here).
   */
  if (!token.startsWith(TOKEN_PREFIX)) throw new Error(message('social.tokenPrefix', { prefix: TOKEN_PREFIX }))
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    throw new Error(message('social.tokenLength', { min: MIN_TOKEN_LENGTH, max: MAX_TOKEN_LENGTH }))
  }
  return token
}

/**
 * Replace the access token, keeping everything else the file says.
 *
 * The copy is taken before the write, so a failed write still leaves the old
 * token recoverable beside it. The write itself is atomic and keeps the file
 * at `0600`, which is what an OAuth flow leaves behind.
 * @param update - the token, and optionally its lifetime and the account name.
 * @param dir - the config directory; the live one by default.
 * @returns the masked state after the write, and the backup's path.
 * @throws {Error} when the token or the lifetime does not pass its check.
 */
export async function saveAccessToken(update: TokenUpdate, dir: string = configDir()): Promise<TokenUpdateResult> {
  const token = checkAccessToken(update.accessToken)
  const expiresIn = update.expiresIn
  if (expiresIn !== undefined && (!Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > MAX_EXPIRES_IN)) {
    throw new Error(message('social.tokenExpiresInvalid'))
  }
  const username = update.username === undefined ? undefined : update.username.trim()
  if (username !== undefined && (username === '' || username.length > 100 || /[\s]/.test(username))) {
    throw new Error(message('social.tokenUsernameInvalid'))
  }
  const path = join(dir, TOKEN_FILE)
  return await serialized(path, async () => {
    const config = await readConfig(dir)
    /*
     * The same token already on file does not get younger: rewriting
     * `obtained` to now would move the computed expiry forward by days, and
     * the page would say "60 left" for a token that has 55. Only a new token —
     * or a declared lifetime — takes the current timestamp.
     */
    const unchanged = textOf(config, 'access_token') === token
    const keepStamp = unchanged && expiresIn === undefined && textOf(config, 'obtained') !== null
    const existed = await stat(path).then(() => true, () => false)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = existed ? `${path}.bak-${stamp}` : null
    if (backup !== null) await copyFile(path, backup)
    const next: Record<string, unknown> = {
      ...config,
      access_token: token,
      ...keepStamp ? {} : { obtained: new Date().toISOString() },
      ...expiresIn === undefined ? {} : { expires_in: expiresIn },
      ...username === undefined ? {} : { username },
    }
    await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    if (backup !== null) await pruneBackups(path, TOKEN_FILE)
    return { state: await readTokenState(dir), backup }
  })
}

/**
 * Drop all but the newest {@link KEPT_BACKUPS} copies of the token file.
 *
 * The copies are named `<file>.bak-<ISO time>`, so their names sort by age.
 * Best effort: a copy that cannot be removed stays, and the save goes on.
 * @param path - the token file.
 */
async function pruneBackups(path: string, file: string = TOKEN_FILE): Promise<void> {
  const prefix = `${file}.bak-`
  const dir = dirname(path)
  try {
    const names = (await readdir(dir)).filter(name => name.startsWith(prefix)).sort()
    for (const name of names.slice(0, Math.max(0, names.length - KEPT_BACKUPS))) {
      await unlink(join(dir, name)).catch(() => undefined)
    }
  } catch {
    // A directory that cannot be read leaves the copies where they are.
  }
}

/** What the settings page may know about the two Facebook tokens. */
export interface FacebookTokenState {
  /** At least one of the two tokens is on the file. */
  readonly hasToken: boolean
  /** The token the comment passes reply with. */
  readonly hasPageToken: boolean
  /** The fallback, and the one that names the account. */
  readonly hasUserToken: boolean
  readonly pageName: string | null
  readonly igUsername: string | null
  readonly fbUserIdTail: string | null
  readonly pageIdTail: string | null
  readonly obtained: string | null
  /**
   * When the **user** token runs out, from `user_token_expires_at`.
   *
   * The page token has no recorded expiry of its own; `null` here means the file
   * does not say, which is not the same as expired.
   */
  readonly expiresAt: string | null
  readonly expiresInDays: number | null
  readonly expiringSoon: boolean
  readonly expired: boolean
}

/** The tokens the page sends: at least one. */
export interface FacebookTokenUpdate {
  readonly pageAccessToken?: string
  readonly userAccessToken?: string
  /** Lifetime in seconds for a **new** user token; absent, the recorded one is dropped. */
  readonly expiresIn?: number
}

/** What a save leaves behind. */
export interface FacebookTokenUpdateResult {
  readonly state: FacebookTokenState
  /** The dated copy of the file, or null when there was no file to copy. */
  readonly backup: string | null
}

/** The last four digits of an id, enough to tell two accounts apart. */
function tailOf(id: string | null): string | null {
  return id === null ? null : id.slice(-4)
}

/**
 * The two tokens as they are, for the only caller that has to send them
 * somewhere: the check against Meta. Everything else in this app reads the
 * masked state.
 * @param dir - the config directory; the live one by default.
 * @returns the tokens, each `null` when it is not on the file.
 */
export async function readFacebookTokens(dir: string = configDir()): Promise<{ page: string | null; user: string | null }> {
  const config = await readConfig(dir, COMMENTS_TOKEN_FILE)
  return { page: textOf(config, 'page_access_token'), user: textOf(config, 'user_access_token') }
}

/**
 * The two tokens' state, masked.
 *
 * `user_token_expires_at` is an epoch in seconds and is the only expiry the file
 * carries: the page token has none (Meta reports 0 = no expiry for it), and the
 * user one may outlive the date the file recorded — on 2026-11-06 the live file
 * said 21 October while Graph still answered with `is_valid: true` and
 * `expires_at: 0`. The page therefore says «recorded expiry passed», not
 * «comments are broken».
 * @param dir - the config directory; the live one by default.
 * @returns the masked state.
 */
export async function readFacebookTokenState(dir: string = configDir()): Promise<FacebookTokenState> {
  const config = await readConfig(dir, COMMENTS_TOKEN_FILE)
  const page = textOf(config, 'page_access_token')
  const user = textOf(config, 'user_access_token')
  const obtained = textOf(config, 'obtained')
  const obtainedAt = obtained === null ? Number.NaN : Date.parse(obtained)
  const declared = typeof config['user_token_expires_at'] === 'number' && config['user_token_expires_at'] > 0
    ? config['user_token_expires_at'] * 1000
    : null
  const expiresInDays = declared === null ? null : Math.floor((declared - Date.now()) / DAY_MS)
  return {
    hasToken: page !== null || user !== null,
    hasPageToken: page !== null,
    hasUserToken: user !== null,
    pageName: textOf(config, 'page_name'),
    igUsername: textOf(config, 'ig_username'),
    fbUserIdTail: tailOf(textOf(config, 'fb_user_id')),
    pageIdTail: tailOf(textOf(config, 'page_id')),
    obtained: Number.isNaN(obtainedAt) ? null : new Date(obtainedAt).toISOString(),
    expiresAt: declared === null ? null : new Date(declared).toISOString(),
    expiresInDays,
    expiringSoon: expiresInDays !== null && expiresInDays >= 0 && expiresInDays <= EXPIRING_SOON_DAYS,
    expired: expiresInDays !== null && expiresInDays < 0,
  }
}

/**
 * Check a pasted Facebook token's shape before anything is written.
 * @param value - what the page sent.
 * @returns the trimmed token.
 * @throws {Error} when the shape is wrong.
 */
export function checkFacebookToken(value: unknown): string {
  const token = typeof value === 'string' ? value.trim() : ''
  if (token === '') throw new Error(message('social.fbTokenEmpty'))
  if (/\s/.test(token)) throw new Error(message('social.tokenWhitespace'))
  if (!token.startsWith(FACEBOOK_PREFIX)) throw new Error(message('social.fbTokenPrefix', { prefix: FACEBOOK_PREFIX }))
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    throw new Error(message('social.tokenLength', { min: MIN_TOKEN_LENGTH, max: MAX_TOKEN_LENGTH }))
  }
  return token
}

/**
 * Replace one or both Facebook tokens, keeping everything else the file says.
 *
 * `page_id`, `fb_user_id`, `page_name`, `permissions`, `source` and `note`
 * belong to the exchange that produced the tokens: they are copied through.
 * A token that is already on the file is not rewritten, and the recorded expiry
 * is only touched when the **user** token actually changes — re-pasting the same
 * two tokens leaves the file as it was, byte for byte, instead of claiming a new
 * sixty days.
 * @param update - the tokens to replace; at least one.
 * @param dir - the config directory; the live one by default.
 * @returns the masked state after the write, and the backup's path.
 * @throws {Error} when neither token is given or one does not pass its check.
 */
export async function saveFacebookTokens(update: FacebookTokenUpdate, dir: string = configDir()): Promise<FacebookTokenUpdateResult> {
  if (update.pageAccessToken === undefined && update.userAccessToken === undefined) {
    throw new Error(message('social.fbTokenEmpty'))
  }
  const page = update.pageAccessToken === undefined ? undefined : checkFacebookToken(update.pageAccessToken)
  const user = update.userAccessToken === undefined ? undefined : checkFacebookToken(update.userAccessToken)
  const expiresIn = update.expiresIn
  if (expiresIn !== undefined && (!Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > MAX_EXPIRES_IN)) {
    throw new Error(message('social.tokenExpiresInvalid'))
  }
  const path = join(dir, COMMENTS_TOKEN_FILE)
  return await serialized(path, async () => {
    const config = await readConfig(dir, COMMENTS_TOKEN_FILE)
    const currentPage = textOf(config, 'page_access_token')
    const currentUser = textOf(config, 'user_access_token')
    const pageChanged = page !== undefined && page !== currentPage
    const userChanged = user !== undefined && user !== currentUser
    const changed = pageChanged || userChanged
    const existed = await stat(path).then(() => true, () => false)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = existed ? `${path}.bak-${stamp}` : null
    if (backup !== null) await copyFile(path, backup)
    const next: Record<string, unknown> = {
      /*
       * The file is created with these three keys when it is missing: the
       * rest — page id, permissions, notes — is added by the exchange, and
       * without `type` the comment manager would not know its shape.
       */
      type: 'facebook_user_and_page_for_ig_comments',
      api_base: 'https://graph.facebook.com',
      ...config,
      ...changed ? { obtained: new Date().toISOString() } : {},
      ...page === undefined ? {} : { page_access_token: page },
      ...user === undefined ? {} : { user_access_token: user },
    }
    if (userChanged) {
      // A new user token does not inherit the old one's expiry: either the
      // saver states it, or the file does not record it (unknown, not expired).
      if (expiresIn === undefined) delete next['user_token_expires_at']
      else next['user_token_expires_at'] = Math.floor((Date.now() + expiresIn * 1000) / 1000)
    }
    await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    if (backup !== null) await pruneBackups(path, COMMENTS_TOKEN_FILE)
    return { state: await readFacebookTokenState(dir), backup }
  })
}
