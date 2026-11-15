/**
 * Are the two comment tokens still good? Asked of Meta, on request.
 *
 * The date written in `facebook_comments_token.json` is what the exchange that
 * produced the tokens believed, and it goes stale: on 2026-11-06 the file said
 * the user token had run out on 21 October while Meta answered `is_valid: true`
 * and `expires_at: 0` for **both** tokens. A red line over something that works
 * is the worst thing a settings page can say, so the page stops guessing and
 * asks.
 *
 * The call is made only when someone presses the button — never while drawing
 * the page — it has a short timeout, it writes nothing, and the tokens travel
 * only inside the query to Meta: the answer, and anything the error says, is
 * cleaned of them before it leaves this module.
 * @module social/token-check
 */
import { message } from '../../../server/src/messages.ts'
import { readFacebookTokens } from './token.ts'

/** Where Meta answers about a token. Pinned like the comment script pins its own calls. */
const GRAPH_VERSION = 'v25.0'
const DEBUG_URL = `https://graph.facebook.com/${GRAPH_VERSION}/debug_token`

/** How long Meta has to answer before the check is reported as unknown. */
export const CHECK_TIMEOUT_MS = 6_000

/** What one token's check says, with nothing of the token in it. */
export interface MetaTokenCheck {
  /** `null` when Meta could not be asked. */
  readonly valid: boolean | null
  readonly type: string | null
  /** `null` means no expiry (`expires_at: 0`), not "expired in 1970". */
  readonly expiresAt: string | null
  readonly dataAccessExpiresAt: string | null
  readonly scopes: number | null
  /** Meta's own reason, when it says the token is not valid. */
  readonly error: string | null
}

/** Both tokens and one verdict for the pair. */
export interface FacebookTokenCheck {
  /** False when there was nothing to ask about. */
  readonly checked: boolean
  readonly page: MetaTokenCheck | null
  readonly user: MetaTokenCheck | null
  /**
   * `valid` when at least one token is good and none is bad — the page token is
   * the one the comment passes reply with, the user one is its fallback.
   * `invalid` as soon as one token is refused.
   */
  readonly verdict: 'valid' | 'invalid' | 'unknown'
  /** Why nothing could be asked, when that is what happened. */
  readonly error: string | null
}

/** Everything a token might be echoed in, scrubbed. */
function redact(text: string, secrets: readonly string[]): string {
  let clean = text
  for (const secret of secrets) {
    if (secret !== '') clean = clean.split(secret).join('[token]')
  }
  return clean
}

/** An epoch in seconds as an ISO instant, with 0 meaning "no expiry". */
function instantOf(seconds: unknown): string | null {
  return typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : null
}

/**
 * Ask Meta about one token.
 *
 * `debug_token` takes the token in both places: `input_token` is the one being
 * asked about, `access_token` is what authorises the question — a user or page
 * token may debug itself, which is what keeps this possible without an app
 * secret on the box.
 * @param token - the token to ask about.
 * @param timeoutMs - how long Meta has to answer.
 * @returns the check, with `valid: null` when Meta could not be asked.
 */
async function checkOne(token: string, timeoutMs: number): Promise<MetaTokenCheck> {
  const query = new URLSearchParams({ input_token: token, access_token: token })
  try {
    const response = await fetch(`${DEBUG_URL}?${query.toString()}`, { signal: AbortSignal.timeout(timeoutMs) })
    const body = await response.json().catch(() => undefined) as
      | { data?: Record<string, unknown>; error?: { message?: unknown } }
      | undefined
    const info = body?.data
    if (info === undefined) {
      const reason = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`
      return {
        valid: null,
        type: null,
        expiresAt: null,
        dataAccessExpiresAt: null,
        scopes: null,
        error: redact(reason, [token]),
      }
    }
    const scopes = Array.isArray(info['scopes']) ? info['scopes'].length : null
    return {
      valid: info['is_valid'] === true,
      type: typeof info['type'] === 'string' ? info['type'] : null,
      expiresAt: instantOf(info['expires_at']),
      dataAccessExpiresAt: instantOf(info['data_access_expires_at']),
      scopes,
      error: info['is_valid'] === true
        ? null
        : typeof body?.error?.message === 'string'
          ? redact(body.error.message, [token])
          : typeof info['error'] === 'object' && info['error'] !== null && typeof (info['error'] as { message?: unknown }).message === 'string'
            ? redact((info['error'] as { message: string }).message, [token])
            : null,
    }
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : ''
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    const detail = error instanceof Error ? error.message : String(error)
    return {
      valid: null,
      type: null,
      expiresAt: null,
      dataAccessExpiresAt: null,
      scopes: null,
      error: timedOut
        ? message('social.checkTimeout', { seconds: Math.round(timeoutMs / 1000) })
        : message('social.checkUnreachable', { reason: redact(detail, [token]) }),
    }
  }
}

/**
 * Ask Meta about both comment tokens.
 *
 * The page token is asked first: it is the one the comment passes reply with, so
 * its refusal is the one that matters. Both are asked even when the first is
 * bad — the page shows the state of each.
 * @param dir - the config directory; the live one by default.
 * @param timeoutMs - how long Meta has to answer, per token.
 * @returns both checks and one verdict; never throws.
 */
export async function checkFacebookTokens(dir?: string, timeoutMs: number = CHECK_TIMEOUT_MS): Promise<FacebookTokenCheck> {
  const { page, user } = await readFacebookTokens(dir)
  if (page === null && user === null) {
    return { checked: false, page: null, user: null, verdict: 'unknown', error: message('social.checkNoTokens') }
  }
  const [pageCheck, userCheck] = await Promise.all([
    page === null ? Promise.resolve(null) : checkOne(page, timeoutMs),
    user === null ? Promise.resolve(null) : checkOne(user, timeoutMs),
  ])
  const checks = [pageCheck, userCheck].filter((one): one is MetaTokenCheck => one !== null)
  const verdict = checks.some(one => one.valid === false)
    ? 'invalid'
    : checks.some(one => one.valid === true)
      ? 'valid'
      : 'unknown'
  return { checked: true, page: pageCheck, user: userCheck, verdict, error: null }
}
