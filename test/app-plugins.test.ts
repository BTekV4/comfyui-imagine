/**
 * Openjutsu and IOPaint as plugins (2026-11-15): each mounts its app under
 * `/apps/<id>` and passes requests to the address in its settings, read at
 * every request; IOPaint drops the prefix (it answers at its root), Openjutsu
 * keeps it (it is built for it). IOPaint also owns «Rimuovi oggetto».
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PluginContext, PluginRoute, PluginSetup } from '../server/src/plugins.ts'

const { default: openjutsu } = await import('../plugins/openjutsu/src/index.ts')
const { default: iopaint } = await import('../plugins/iopaint/src/index.ts')

/** The fake app: echoes the path and Host it received. */
let app: Server
let appUrl = ''
before(async () => {
  app = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, host: req.headers.host, origin: req.headers.origin ?? null }))
  })
  await new Promise<void>((resolve) => { app.listen(0, '127.0.0.1', resolve) })
  appUrl = `http://127.0.0.1:${String((app.address() as AddressInfo).port)}`
})
after(() => { app.close() })

/** A context with just what these plugins read. */
function contextWith(values: Record<string, string>): PluginContext {
  return { config: () => values, mediaDir: '/nonexistent' } as unknown as PluginContext
}

/** Run one route against a throwaway server and read the answer. */
async function call(route: PluginRoute, path: string, cookie?: string): Promise<{ status: number; body: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { void route.handler(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  try {
    const port = (server.address() as AddressInfo).port
    return await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { origin: 'https://studio.example', ...cookie === undefined ? {} : { cookie } } }, (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
      })
      req.on('error', reject)
      req.end()
    })
  } finally {
    server.close()
  }
}

const routeOf = (setup: PluginSetup, path: string): PluginRoute => {
  const found = setup.routes?.find(route => route.path === path)
  assert.ok(found, `route ${path}`)
  return found
}

test('Openjutsu: /apps/openjutsu goes through with its prefix, Origin dropped', async () => {
  const setup = await openjutsu(contextWith({ url: appUrl })) as PluginSetup
  const route = routeOf(setup, '/apps/openjutsu')
  assert.equal(route.kind, 'prefix')
  const answer = await call(route, '/apps/openjutsu/_next/x.js?a=1')
  assert.equal(answer.status, 200)
  const seen = JSON.parse(answer.body) as { path: string; host: string; origin: string | null }
  assert.equal(seen.path, '/apps/openjutsu/_next/x.js?a=1')
  assert.equal(seen.host, new URL(appUrl).host)
  assert.equal(seen.origin, null)
})

test('IOPaint: /apps/iopaint goes through without the prefix, and erase is its route', async () => {
  const setup = await iopaint(contextWith({ url: appUrl })) as PluginSetup
  assert.deepEqual(setup.routes?.map(route => route.path).sort(), ['/apps/iopaint', '/plugin/iopaint/erase'])
  const answer = await call(routeOf(setup, '/apps/iopaint'), '/apps/iopaint/api/v1/server-config')
  assert.equal((JSON.parse(answer.body) as { path: string }).path, '/api/v1/server-config')
})

test('the address is read at every request: a setting saved later applies at once', async () => {
  const values: Record<string, string> = { url: 'http://127.0.0.1:9' }
  const setup = await iopaint(contextWith(values)) as PluginSetup
  const route = routeOf(setup, '/apps/iopaint')
  const down = await call(route, '/apps/iopaint/')
  assert.equal(down.status, 502)
  // A page that says what is missing, not a bare line that reads as blank.
  assert.match(down.body, /<h1>IOPaint non risponde<\/h1>/)
  assert.match(down.body, /http:\/\/127\.0\.0\.1:9/)
  values['url'] = appUrl
  assert.equal((await call(route, '/apps/iopaint/')).status, 200)
})

test('the "does not answer" page speaks the language the studio is shown in', async () => {
  const setup = await iopaint(contextWith({ url: 'http://127.0.0.1:9' })) as PluginSetup
  const route = routeOf(setup, '/apps/iopaint')
  // Italian chosen, but the studio fell back to English: the page follows the studio.
  const shownEnglish = await call(route, '/apps/iopaint/', 'imagine_locale=it; imagine_shown_locale=en')
  assert.match(shownEnglish.body, /<h1>IOPaint does not answer<\/h1>/)
  const shownItalian = await call(route, '/apps/iopaint/', 'imagine_shown_locale=it')
  assert.match(shownItalian.body, /<h1>IOPaint non risponde<\/h1>/)
})

test('the status says whether the app answers', async () => {
  const up = await (await openjutsu(contextWith({ url: appUrl })) as PluginSetup).status?.()
  assert.equal(up?.ok, true)
  const down = await (await iopaint(contextWith({ url: 'http://127.0.0.1:9' })) as PluginSetup).status?.()
  assert.equal(down?.ok, false)
})
