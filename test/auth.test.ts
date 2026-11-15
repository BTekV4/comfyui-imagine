/**
 * The login: off until asked for, and a cookie the browser keeps on plain
 * http too. Until 2026-11-15 the cookie was always `Secure`, so a studio
 * opened at http://<lan address>:3090 sent the visitor back to the form after
 * a correct password.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth } from '../server/src/auth.ts'
import { savePassword } from '../server/src/password.ts'

let dir = ''
let server: Server
let base = ''
let required = false

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imagine-auth-'))
  await savePassword(join(dir, 'password.json'), 'correct horse battery')
  const auth = createAuth({ passwordFile: join(dir, 'password.json'), secretFile: join(dir, 'cookie-secret'), required: () => required })
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/login') { void auth.handleLogin(req, res); return }
    // The test talks over loopback, which the guard lets through; pretend it is the LAN.
    Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.50' })
    if (auth.guard(req, res, path)) res.end('studio')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})
after(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

const login = (headers: Record<string, string> = {}): Promise<Response> => fetch(`${base}/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: 'password=correct+horse+battery',
})

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
  const pair = cookie.split(';')[0] ?? ''
  assert.equal(await (await fetch(base, { headers: { cookie: pair } })).text(), 'studio')
})

test('behind an HTTPS proxy the cookie is Secure', async () => {
  const answer = await login({ 'x-forwarded-proto': 'https' })
  assert.match(answer.headers.get('set-cookie') ?? '', /; Secure/)
})
