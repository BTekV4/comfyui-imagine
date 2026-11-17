/**
 * The login: off until asked for, and a cookie the browser keeps on plain
 * http too. Until 2026-11-15 the cookie was always `Secure`, so a studio
 * opened at http://<lan address>:3090 sent the visitor back to the form after
 * a correct password.
 *
 * The cookie lasts 30 days and slides while it is used; saving a password
 * revokes every session minted before it, while the browser that made the
 * change is handed a fresh one. `POST /logout` clears it.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth, type Auth } from '../server/src/auth.ts'
import { savePassword } from '../server/src/password.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const PASSWORD = 'correct horse battery'

let dir = ''
let server: Server
let base = ''
let required = false
let clockNow = Date.now()
let auth: Auth
let secret = ''

function newAuth(): Auth {
  return createAuth({
    passwordFile: join(dir, 'password.json'),
    secretFile: join(dir, 'cookie-secret'),
    required: () => required,
    now: () => clockNow,
  })
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imagine-auth-'))
  await savePassword(join(dir, 'password.json'), PASSWORD)
  auth = newAuth()
  secret = await import('node:fs/promises').then(fs => fs.readFile(join(dir, 'cookie-secret'), 'utf8')).then(text => text.trim())
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/login') { void auth.handleLogin(req, res); return }
    if (path === '/logout') { auth.handleLogout(req, res); return }
    // The test talks over loopback, which the guard lets through; pretend it is the LAN.
    Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.50', configurable: true })
    void auth.guard(req, res, path).then((allowed) => { if (allowed) res.end('studio') })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})
after(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

const login = (password = PASSWORD, headers: Record<string, string> = {}): Promise<Response> => fetch(`${base}/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: `password=${encodeURIComponent(password)}`,
})

/** The `name=value` pair of a Set-Cookie header. */
const pairOf = (response: Response): string => (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

const open = (cookie: string): Promise<Response> => fetch(base, { redirect: 'manual', headers: { cookie } })

test('with "Ask for the password" off the studio is open', async () => {
  required = false
  assert.equal(await (await fetch(base)).text(), 'studio')
})

test('with it on, a visitor without the cookie is sent to the form', async () => {
  required = true
  const answer = await fetch(base, { redirect: 'manual', headers: { accept: 'text/html' } })
  assert.equal(answer.status, 302)
  assert.equal(answer.headers.get('location'), '/login')
})

test('over plain http the cookie is not Secure, so the browser keeps it, and it opens the studio', async () => {
  required = true
  const answer = await login()
  assert.equal(answer.status, 302)
  const cookie = answer.headers.get('set-cookie') ?? ''
  assert.match(cookie, /^imagine-auth=/)
  assert.doesNotMatch(cookie, /Secure/)
  assert.match(cookie, /Max-Age=2592000;/, 'thirty days')
  assert.equal(await (await open(pairOf(answer))).text(), 'studio')
})

test('behind an HTTPS proxy the cookie is Secure', async () => {
  const answer = await login(PASSWORD, { 'x-forwarded-proto': 'https' })
  assert.match(answer.headers.get('set-cookie') ?? '', /; Secure/)
})

test('a cookie this old is refused', async () => {
  const answer = await login()
  const cookie = pairOf(answer)
  clockNow += 31 * DAY_MS
  const stale = await open(cookie)
  assert.equal(stale.status, 401)
  clockNow -= 31 * DAY_MS
})

test('a cookie in its second half is renewed while it is used, and the new one lives longer', async () => {
  const first = await login()
  const oldCookie = pairOf(first)
  clockNow += 20 * DAY_MS
  const answer = await open(oldCookie)
  assert.equal(await answer.text(), 'studio')
  const renewed = answer.headers.get('set-cookie') ?? ''
  assert.match(renewed, /^imagine-auth=/)
  // Twenty more days: the original cookie would be at day 40, the renewed one at day 20.
  clockNow += 20 * DAY_MS
  assert.equal(await (await open(pairOf(answer))).text(), 'studio')
  clockNow -= 40 * DAY_MS
})

test('a new password revokes every old cookie, and the browser that changed it gets a fresh one', async () => {
  const oldCookie = pairOf(await login())
  await savePassword(join(dir, 'password.json'), 'a different password')
  const revoked = await open(oldCookie)
  assert.equal(revoked.status, 401)
  // The same auth instance hands this browser a cookie for the new generation.
  const renewed = await new Promise<Response>((resolve, reject) => {
    const request = createServer((req, res) => {
      void auth.renew(req, res).then(() => res.writeHead(200).end())
      void request
    })
    request.listen(0, '127.0.0.1', () => {
      const address = request.address() as AddressInfo
      void fetch(`http://127.0.0.1:${String(address.port)}`, { headers: { cookie: oldCookie } })
        .then(resolve, reject)
        .finally(() => { request.close() })
    })
  })
  assert.equal(await (await open(pairOf(renewed))).text(), 'studio')
  // Back to the password the later tests log in with.
  await savePassword(join(dir, 'password.json'), PASSWORD)
})

test('a cookie from before generations existed is refused, without a crash', async () => {
  const body = Buffer.from(JSON.stringify({ v: 1, exp: clockNow + DAY_MS })).toString('base64url')
  const signature = Buffer.from(createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest()).toString('base64url')
  const answer = await open(`imagine-auth=${body}.${signature}`)
  assert.equal(answer.status, 401)
})

test('logout clears the cookie and goes back to the form', async () => {
  const cookie = pairOf(await login())
  const answer = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie } })
  assert.equal(answer.status, 302)
  assert.equal(answer.headers.get('location'), '/login')
  assert.match(answer.headers.get('set-cookie') ?? '', /imagine-auth=; Max-Age=0;/)
  // GET is refused: a link or an image must not log the visitor out.
  const viaGet = await fetch(`${base}/logout`, { redirect: 'manual', headers: { cookie } })
  assert.equal(viaGet.status, 405)
})

test('a restart keeps the generation: the old cookie stays refused and the new password works', async () => {
  const cookie = pairOf(await login())
  const restarted = newAuth()
  auth = restarted
  assert.equal((await open(cookie)).status, 200)
  await savePassword(join(dir, 'password.json'), 'a restart password')
  assert.equal((await open(cookie)).status, 401)
  const fresh = await login('a restart password')
  assert.equal(await (await open(pairOf(fresh))).text(), 'studio')
})
