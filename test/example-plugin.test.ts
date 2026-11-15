/**
 * The example plugin: it must be the right model, so it is tested the way
 * whoever copies it will use it — build, loading, fields, test action and bus.
 *
 * The bundle is written to a temporary folder (`PLUGINS_OUT`), so running the
 * tests never rewrites files in the working tree.
 *
 * The network is replaced: a test that really sends a POST to some address is
 * not a test, it is trouble.
 */
import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { fakePluginHost } from './helpers/plugin-host.ts'

const run = promisify(execFile)
const { createPlugins } = await import('../server/src/plugins.ts')

const root = await mkdtemp(join(tmpdir(), 'imagine-example-plugin-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

const OUT = join(root, 'build')
const BUNDLE = join(OUT, 'example-webhook', 'index.mjs')
const SOURCE = join('plugins', 'example-webhook', 'src', 'index.ts')

/** Builds the plugins once into the temporary folder; every test waits for it. */
const built = run(process.execPath, ['scripts/build.mjs', 'plugins'], {
  timeout: 60_000,
  env: { ...process.env, PLUGINS_OUT: OUT },
})
// Observed here so a failed build is reported by the first test, not as an unhandled rejection.
built.catch(() => undefined)

/** The fake calls, so nothing goes to the internet. */
let calls: { url: string; body: unknown; headers: Record<string, string> }[] = []
const realFetch = globalThis.fetch
beforeEach(() => { calls = [] })
after(() => { globalThis.fetch = realFetch })

function answerWith(handler: () => unknown): void {
  globalThis.fetch = (async (input: string | URL, init?: { body?: string; headers?: Record<string, string> }) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
      headers: init?.headers ?? {},
    })
    return handler()
  }) as unknown as typeof fetch
}

/** The plugin installed in a throwaway data folder, with its bus. */
async function load(): Promise<{
  plugins: Awaited<ReturnType<typeof createPlugins>>
  dir: string
  routes: { path: string; handler: (req: unknown, res: unknown) => unknown }[]
  bus: ReturnType<typeof fakePluginHost>['bus']
}> {
  await built
  const dir = await mkdtemp(join(root, 'data-'))
  const folder = join(dir, 'example-webhook')
  await mkdir(folder, { recursive: true })
  await copyFile(join('plugins', 'example-webhook', 'manifest.json'), join(folder, 'manifest.json'))
  await copyFile(BUNDLE, join(folder, 'index.mjs'))
  const fake = fakePluginHost({ mediaDir: dir })
  const { bus } = fake
  const routes = fake.routes as unknown as { path: string; handler: (req: unknown, res: unknown) => unknown }[]
  const plugins = await createPlugins({
    dir,
    host: fake.host,
  })
  await plugins.start()
  return { plugins, dir, routes, bus }
}

/** A fake request and response for the plugin's route. */
function fakeRequest(method = 'POST'): unknown {
  return { method, resume: () => undefined }
}
function fakeResponse(): { statusCode: number; body: string; headers: Record<string, string>; setHeader: (n: string, v: string) => void; end: (b?: string) => void } {
  const response = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { response.headers[name] = value },
    end(body?: string) { response.body = body ?? '' },
  }
  return response
}

test('the source is in the repo, the bundle builds and imports only builtins', async () => {
  const source = await readFile(SOURCE, 'utf8')
  // An example to read: past a hundred-odd lines it is no longer an example.
  assert.ok(source.split('\n').length < 130, `source too long: ${String(source.split('\n').length)} lines`)
  const { stdout } = await built
  assert.match(stdout, /plugin example-webhook: index\.mjs/)
  const info = await stat(BUNDLE)
  assert.ok(info.size > 1_000, 'the bundle exists')
  const text = await readFile(BUNDLE, 'utf8')
  for (const line of text.split('\n').filter(line => line.startsWith('import '))) {
    assert.match(line, /from "node:/, `non-builtin import: ${line}`)
  }
  const module = await import(pathToFileURL(BUNDLE).href) as { default?: unknown }
  assert.equal(typeof module.default, 'function')
})

test('without an address the status says so and the test action is a 400 without network', async () => {
  answerWith(() => ({ ok: true, status: 200 }))
  const { plugins, routes } = await load()
  const view = (await plugins.list())[0]!
  assert.equal(view.loaded, true, `not loaded: ${String(view.error)}`)
  assert.deepEqual(view.status, {
    ok: false,
    summary: { en: 'no address yet', it: 'no address yet' },
    detail: { en: 'forwarding the notices', it: 'forwarding the notices' },
  })
  const response = fakeResponse()
  await routes[0]!.handler(fakeRequest(), response)
  assert.equal(response.statusCode, 400)
  assert.equal(calls.length, 0, 'without an address nobody is called')
  assert.deepEqual(view.actions.map(action => action.key), ['test'])
  plugins.dispose()
})

test('the test action sends the right text, with the secret in a header', async () => {
  answerWith(() => ({ ok: true, status: 200 }))
  const { plugins, routes } = await load()
  await plugins.saveSettings('example-webhook', { url: 'https://example.test/hook', enabled: true, secret: 's3gr3to' })
  const view = (await plugins.list())[0]!
  assert.equal(view.status?.ok, true)
  assert.equal(view.status?.summary?.en, '→ example.test')
  const response = fakeResponse()
  await routes[0]!.handler(fakeRequest(), response)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://example.test/hook')
  assert.deepEqual(calls[0]?.body, { text: 'Example webhook: this is a test from the studio.' })
  assert.equal(calls[0]?.headers['x-webhook-secret'], 's3gr3to')
  // The password never goes back to the page.
  assert.equal(JSON.stringify(view).includes('s3gr3to'), false)
  assert.equal(view.settings.find(setting => setting.key === 'secret')?.isSet, true)
  plugins.dispose()
})

test('an address that does not answer is a 502 with the reason, not an error that bubbles up', async () => {
  globalThis.fetch = (async () => { throw new Error('getaddrinfo ENOTFOUND example.test') }) as unknown as typeof fetch
  const { plugins, routes } = await load()
  await plugins.saveSettings('example-webhook', { url: 'https://example.test/hook', enabled: true })
  const response = fakeResponse()
  await routes[0]!.handler(fakeRequest(), response)
  assert.equal(response.statusCode, 502)
  const answer = JSON.parse(response.body) as { ok: boolean; error: string }
  assert.equal(answer.ok, false)
  assert.match(answer.error, /ENOTFOUND/)
  // And the status stays good: the address is configured, it is the network that is missing.
  assert.equal((await plugins.list())[0]?.status?.ok, true)
  plugins.dispose()
})

test('a bus notice reaches the address, and with the toggle off it is not sent', async () => {
  answerWith(() => ({ ok: true, status: 200 }))
  const { plugins, bus } = await load()
  await plugins.saveSettings('example-webhook', { url: 'https://example.test/hook', enabled: false })
  await bus.notify('notice with the plugin off')
  assert.equal(calls.length, 0, 'off means off')
  await plugins.saveSettings('example-webhook', { enabled: true })
  await bus.notify('⚠️ Scheduled post: publishing failed')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.body, { text: '⚠️ Scheduled post: publishing failed' })
  plugins.dispose()
})

test('an address that answers 500 is a refusal, not a success', async () => {
  answerWith(() => ({ ok: false, status: 500 }))
  const { plugins, routes } = await load()
  await plugins.saveSettings('example-webhook', { url: 'https://example.test/hook' })
  const response = fakeResponse()
  await routes[0]!.handler(fakeRequest(), response)
  assert.equal(response.statusCode, 502)
  assert.match(response.body, /HTTP 500/)
  plugins.dispose()
})
