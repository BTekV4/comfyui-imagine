/**
 * The warning about a studio open to the network (listening beyond loopback,
 * no login) can be hidden for the whole studio, not only for the browser that
 * hid it. The choice is one small file in the data folder: a reload and a
 * second browser see it, and it survives a restart.
 *
 * It is tied to the situation that produced it: a different listening address
 * puts the warning back, and so does the login being switched on and off
 * again. The two POSTs that change it are refused from another origin.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccessBanner, forgetDismissalWhenLoginMoves, type AccessBanner } from '../server/src/access-banner.ts'
import {
  ACCESS_PATH, HIDE_BANNER_PATH, SHOW_BANNER_PATH, createAccessRoutes,
} from '../server/src/access-routes.ts'
import type { WebRoute } from '../server/src/host.ts'

/** File modes do not exist on Windows: the writer ignores the mode there. */
const WINDOWS = process.platform === 'win32'

/** The headers a browser sends a same-origin POST. */
const SAME_ORIGIN = { host: 'studio.test:3090', origin: 'http://studio.test:3090' }

/** Call a route the way the server's dispatcher does, with no body to read. */
async function call(route: WebRoute, options: {
  readonly method?: string
  readonly headers?: Record<string, string>
} = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = {
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    resume: () => undefined,
  } as unknown as IncomingMessage
  let status = 0
  let text = ''
  const res = {
    req,
    writeHead(code: number) { status = code; return this },
    setHeader() { return this },
    end(body?: string) { text = body ?? '' },
  } as unknown as ServerResponse
  await route.handler(req, res)
  return { status, body: JSON.parse(text) as Record<string, unknown> }
}

/** The route with that path, which every table built here has. */
function routeOf(routes: readonly WebRoute[], path: string): WebRoute {
  const found = routes.find(route => route.path === path)
  assert.ok(found !== undefined, `no route ${path}`)
  return found
}

/** The routes of a studio listening on `host`. */
function routesFor(banner: AccessBanner, host: string, loginRequired = false): WebRoute[] {
  return createAccessRoutes({
    banner,
    listenHost: host,
    exposed: true,
    loginRequired: () => loginRequired,
    passwordSet: () => false,
  })
}

test('the hidden warning is kept for the studio and survives a reload', { skip: WINDOWS && 'file modes are not meaningful on Windows' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagine-banner-'))
  try {
    const file = join(dir, 'access-banner.json')
    const routes = routesFor(await createAccessBanner(file), '0.0.0.0')
    assert.equal((await call(routeOf(routes, ACCESS_PATH))).body['bannerDismissed'], false)
    const hidden = await call(routeOf(routes, HIDE_BANNER_PATH), { method: 'POST', headers: SAME_ORIGIN })
    assert.equal(hidden.status, 200)
    assert.equal(hidden.body['bannerDismissed'], true)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    /*
     * A reload or another device reads the file again: the in-memory state of
     * one process is not what the owner sees.
     */
    const reloaded = await createAccessBanner(file)
    assert.equal(reloaded.hiddenFor(), '0.0.0.0')
    assert.equal((await call(routeOf(routesFor(reloaded, '0.0.0.0'), ACCESS_PATH))).body['bannerDismissed'], true)
    // The settings page puts it back for everyone.
    const shown = await call(routeOf(routesFor(reloaded, '0.0.0.0'), SHOW_BANNER_PATH), {
      method: 'POST',
      headers: SAME_ORIGIN,
    })
    assert.equal(shown.body['bannerDismissed'], false)
    assert.equal((await createAccessBanner(file)).hiddenFor(), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a different listening address shows the warning again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagine-banner-'))
  try {
    const banner = await createAccessBanner(join(dir, 'access-banner.json'))
    const before = routesFor(banner, '0.0.0.0')
    await call(routeOf(before, HIDE_BANNER_PATH), { method: 'POST', headers: SAME_ORIGIN })
    assert.equal((await call(routeOf(before, ACCESS_PATH))).body['bannerDismissed'], true)
    // `host:` in the config moved: the file still names the old address.
    const moved = routesFor(banner, '192.168.1.20')
    assert.equal((await call(routeOf(moved, ACCESS_PATH))).body['bannerDismissed'], false)
    assert.equal(banner.hiddenFor(), '0.0.0.0')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the login switch moving forgets the hidden warning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagine-banner-'))
  try {
    const banner = await createAccessBanner(join(dir, 'access-banner.json'))
    await banner.hide('0.0.0.0')
    // On and then off again: the studio really was closed in between.
    await forgetDismissalWhenLoginMoves(banner, false, true)
    assert.equal(banner.hiddenFor(), undefined)
    await banner.hide('0.0.0.0')
    await forgetDismissalWhenLoginMoves(banner, true, false)
    assert.equal(banner.hiddenFor(), undefined)
    // A save that leaves the switch alone changes nothing.
    await banner.hide('0.0.0.0')
    await forgetDismissalWhenLoginMoves(banner, false, false)
    assert.equal(banner.hiddenFor(), '0.0.0.0')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('with the login on there is no strip, and a stale tab cannot hide it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagine-banner-'))
  try {
    const banner = await createAccessBanner(join(dir, 'access-banner.json'))
    const routes = routesFor(banner, '0.0.0.0', true)
    const answer = await call(routeOf(routes, HIDE_BANNER_PATH), { method: 'POST', headers: SAME_ORIGIN })
    assert.equal(answer.status, 200)
    assert.equal(banner.hiddenFor(), undefined)
    assert.equal(answer.body['bannerDismissed'], false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hiding the warning is refused from another origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagine-banner-'))
  try {
    const file = join(dir, 'access-banner.json')
    const banner = await createAccessBanner(file)
    const routes = routesFor(banner, '0.0.0.0')
    const refused = await call(routeOf(routes, HIDE_BANNER_PATH), {
      method: 'POST',
      headers: { host: 'studio.test:3090', origin: 'https://evil.example' },
    })
    assert.equal(refused.status, 403)
    assert.equal(banner.hiddenFor(), undefined)
    await assert.rejects(stat(file), /ENOENT/)
    // No origin at all is not a browser (curl, the desktop window): it passes.
    const curl = await call(routeOf(routes, HIDE_BANNER_PATH), { method: 'POST', headers: { host: 'studio.test:3090' } })
    assert.equal(curl.status, 200)
    assert.equal(banner.hiddenFor(), '0.0.0.0')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
