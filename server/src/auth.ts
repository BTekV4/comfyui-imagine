/**
 * Password login for the standalone studio.
 *
 * Off until the owner sets a password and turns on "Ask for the password"
 * (Settings → Access). Then: a scrypt record on disk, a signed cookie that
 * lasts 30 days and is renewed while it is used, and a small brute-force brake.
 * Requests from loopback skip the check: they are the probes run on the box
 * itself.
 *
 * Every cookie carries the session generation stored beside the password hash
 * (see `password.ts`). Saving a new password bumps it, so every cookie minted
 * before the change stops opening the studio; the browser that made the change
 * is handed a fresh one in the same answer. There is also `POST /logout`, which
 * clears the cookie.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parsePasswordRecord, verifyPassword, type PasswordRecord } from './password.ts'
import { languageKind, messageIn } from './messages.ts'
import { cookieOf, languageOf, notAllowed, pageLanguageOf, readBody } from './route-kit.ts'

const COOKIE = 'imagine-auth'
/** How long a cookie is good for: 30 days, renewed while the studio is used. */
const COOKIE_DAYS = 30
/**
 * A cookie this close to its end is replaced on the next request it opens the
 * studio with. Half the lifetime: a browser used once a month keeps its session
 * without an extension every time.
 */
const RENEW_MS = (COOKIE_DAYS / 2) * 24 * 60 * 60 * 1000
const MAX_FAILURES = 8
const FAILURE_WINDOW_MS = 15 * 60 * 1000
/**
 * The proxies whose `X-Forwarded-For` is believed. Empty by default: from
 * anyone else the header is the client's own claim, and trusting it lets a
 * client dodge the brake by inventing a new address for every try. A
 * deployment behind a reverse proxy lists that proxy in `trustedProxies`.
 */
const DEFAULT_TRUSTED_PROXIES: readonly string[] = []

const b64url = (value: Buffer | string): string => Buffer.from(value).toString('base64url')

/** What a signed cookie says. */
interface SessionPayload {
  /** When it stops being accepted, in epoch milliseconds. */
  readonly exp: number
  /** The password record's generation it was minted for. */
  readonly gen: number
}

/** The guard every request passes through, and the `/login` form it serves. */
export interface Auth {
  /** True when the request may go on; otherwise the response is already sent. */
  guard(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>
  /** Serve `/login` (GET form, POST check). */
  handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** `POST /logout`: clear the cookie and go back to the form. */
  handleLogout(req: IncomingMessage, res: ServerResponse): void
  /**
   * Hand this answer a cookie for the current session generation. Used after a
   * password change: the cookie in the request is from the generation just
   * revoked, and this one keeps the browser that made the change inside.
   */
  renew(req: IncomingMessage, res: ServerResponse): Promise<void>
}

export function createAuth(options: {
  passwordFile: string
  secretFile: string
  required: () => boolean
  trustedProxies?: readonly string[]
  /** The clock, for the tests that age a cookie without waiting. */
  now?: () => number
}): Auth {
  if (!existsSync(options.secretFile)) writeFileSync(options.secretFile, randomBytes(32).toString('base64url'), { mode: 0o600 })
  const secret = Buffer.from(readFileSync(options.secretFile, 'utf8').trim(), 'base64url')
  const clock = options.now ?? Date.now
  const failures = new Map<string, number[]>()
  const trusted = new Set((options.trustedProxies ?? DEFAULT_TRUSTED_PROXIES).flatMap(address => [address, `::ffff:${address}`]))
  // Addresses that stopped trying would otherwise stay in the map for good.
  setInterval(() => {
    const now = clock()
    for (const [client, times] of failures) {
      const recent = times.filter(at => now - at < FAILURE_WINDOW_MS)
      if (recent.length === 0) failures.delete(client)
      else failures.set(client, recent)
    }
  }, FAILURE_WINDOW_MS).unref()

  const sign = (body: string): string => b64url(createHmac('sha256', secret).update(body).digest())

  /*
   * `Secure` only when the browser really is on HTTPS: a direct TLS socket, or
   * a reverse proxy saying so in X-Forwarded-Proto. On plain http (a studio
   * opened at http://192.168.x.y:3090) a Secure cookie is dropped by the
   * browser, and the login sent the visitor straight back to the form
   * (2026-11-15, found installing from the public repo). Trusting the header
   * from anyone is harmless here: all it can do is make the sender's own
   * cookie stricter.
   */
  const overHttps = (req: IncomingMessage): boolean => {
    if ((req.socket as { encrypted?: boolean }).encrypted === true) return true
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim().toLowerCase()
    return proto === 'https'
  }

  /** The cookie for one session, signed and scoped. */
  const mint = (req: IncomingMessage, generation: number): string => {
    const body = b64url(JSON.stringify({ v: 2, exp: clock() + COOKIE_DAYS * 24 * 60 * 60 * 1000, gen: generation }))
    return `${COOKIE}=${body}.${sign(body)}; Max-Age=${String(COOKIE_DAYS * 24 * 60 * 60)}; Path=/; HttpOnly; SameSite=Lax${overHttps(req) ? '; Secure' : ''}`
  }

  /** A header that deletes the cookie, on the same path and with the same flags. */
  const cleared = (req: IncomingMessage): string =>
    `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${overHttps(req) ? '; Secure' : ''}`

  /*
   * The password record's generation, cached beside the inode it was read from:
   * a password change replaces the file by rename, so a new inode (and on
   * Windows a new timestamp) is what makes the cache miss. The read is small,
   * and this runs only for a request that carries a cookie.
   */
  let knownGeneration: { readonly ino: number; readonly mtime: number; readonly ctime: number; readonly size: number; readonly value: number } | undefined
  const generation = async (): Promise<number> => {
    try {
      const info = await stat(options.passwordFile)
      if (knownGeneration !== undefined
        && knownGeneration.ino === info.ino
        && knownGeneration.mtime === info.mtimeMs
        && knownGeneration.ctime === info.ctimeMs
        && knownGeneration.size === info.size) return knownGeneration.value
      const record = parsePasswordRecord(await readFile(options.passwordFile, 'utf8'))
      knownGeneration = { ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size, value: record.generation }
      return record.generation
    } catch {
      // No password yet, or a record that cannot be read: no session can be valid.
      return 0
    }
  }

  /** The payload of a valid cookie, or undefined when it is missing, forged, stale or revoked. */
  const payloadOf = async (req: IncomingMessage): Promise<SessionPayload | undefined> => {
    const raw = cookieOf(req, COOKIE)
    if (raw === undefined) return undefined
    const [body, sig] = raw.split('.')
    if (body === undefined || sig === undefined) return undefined
    const expected = Buffer.from(sign(body))
    const actual = Buffer.from(sig)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp?: unknown; gen?: unknown }
      if (typeof payload.exp !== 'number' || typeof payload.gen !== 'number' || payload.exp <= clock()) return undefined
      if (payload.gen !== await generation()) return undefined
      return { exp: payload.exp, gen: payload.gen }
    } catch {
      return undefined
    }
  }

  const loopback = (req: IncomingMessage): boolean => {
    const address = req.socket.remoteAddress ?? ''
    return req.headers['x-forwarded-for'] === undefined
      && (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1')
  }

  const clientOf = (req: IncomingMessage): string => {
    const address = String(req.socket.remoteAddress)
    if (!trusted.has(address)) return address
    // The proxy appends the address it saw last: that one it vouches for.
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map(part => part.trim()).filter(part => part !== '')
    return forwarded.at(-1) ?? address
  }

  /** The scrypt record, re-read only when the settings page rewrote the file. */
  let record: { readonly ino: number; readonly mtime: number; readonly ctime: number; readonly size: number; readonly record: PasswordRecord } | undefined
  const passwordMatches = async (candidate: string): Promise<boolean> => {
    const info = await stat(options.passwordFile)
    // An atomic rename gives a new inode: the timestamp alone can repeat when
    // two saves land in the same millisecond, and the old record would be used.
    if (record?.ino !== info.ino || record.mtime !== info.mtimeMs || record.ctime !== info.ctimeMs || record.size !== info.size) {
      record = { ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size, record: parsePasswordRecord(await readFile(options.passwordFile, 'utf8')) }
    }
    return verifyPassword(candidate, record.record)
  }

  /*
   * The form is in the language the studio's page last chose (its cookie),
   * Italian on a first visit, like the studio itself.
   */
  const page = (req: IncomingMessage, error?: 'auth.tooManyAttempts' | 'auth.requestTooLarge' | 'auth.wrongPassword'): string => {
    const language = pageLanguageOf(req)
    return `<!doctype html><html lang="${languageKind(language)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${messageIn(language, 'auth.title')}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
font:15px/1.4 system-ui,sans-serif;background:#0b0b0c;color:#f2f2f2}form{width:min(320px,90vw);display:grid;gap:12px}
h1{font-size:20px;font-weight:600;margin:0 0 8px}input,button{font:inherit;padding:12px 14px;border-radius:12px;border:1px solid #333;
background:#151517;color:inherit}button{background:#f2f2f2;color:#0b0b0c;border:0;font-weight:600;cursor:pointer}
p{color:#ff7b72;margin:0}</style></head><body><form method="post" action="/login">
<h1>Imagine</h1>${error === undefined ? '' : `<p>${messageIn(language, error)}</p>`}
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required>
<button type="submit">${messageIn(language, 'auth.submit')}</button></form></body></html>`
  }

  return {
    async guard(req, res, path) {
      if (!options.required() || path === '/login' || path === '/logout' || path === '/api/access' || loopback(req)) return true
      const payload = await payloadOf(req)
      if (payload !== undefined) {
        // Sliding lifetime: a session in its last half is replaced while it is used.
        if (payload.exp - clock() < RENEW_MS) res.setHeader('set-cookie', mint(req, payload.gen))
        return true
      }
      const wantsPage = req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')
      if (wantsPage) {
        res.writeHead(302, { location: '/login' }).end()
      } else {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: messageIn(languageOf(req), 'auth.loginRequired') }))
      }
      return false
    },
    async handleLogin(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(req))
        return
      }
      const client = clientOf(req)
      const now = clock()
      const recent = (failures.get(client) ?? []).filter(at => now - at < FAILURE_WINDOW_MS)
      if (recent.length >= MAX_FAILURES) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' }).end(page(req, 'auth.tooManyAttempts'))
        return
      }
      let body: string
      try {
        body = (await readBody(req, 4096)).toString('utf8')
      } catch {
        res.writeHead(413, { 'content-type': 'text/html; charset=utf-8' }).end(page(req, 'auth.requestTooLarge'))
        return
      }
      const password = new URLSearchParams(body).get('password') ?? ''
      if (password !== '' && await passwordMatches(password).catch(() => false)) {
        failures.delete(client)
        res.writeHead(302, { 'set-cookie': mint(req, await generation()), location: '/' }).end()
        return
      }
      failures.set(client, [...recent, now])
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(page(req, 'auth.wrongPassword'))
    },
    handleLogout(req, res) {
      if (req.method !== 'POST') {
        notAllowed(res, 'POST')
        return
      }
      res.writeHead(302, { 'set-cookie': cleared(req), location: options.required() ? '/login' : '/' }).end()
    },
    async renew(req, res) {
      res.setHeader('set-cookie', mint(req, await generation()))
    },
  }
}
