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
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fakeFetch } from './helpers/fake-fetch.ts'
import { fakeRequest, fakeResponse } from './helpers/fake-http.ts'
import { installPlugin, type Plugins } from './helpers/plugin-files.ts'
import { builtPlugins, bundleOf } from './helpers/plugin-bundle.ts'
import type { fakePluginHost } from './helpers/plugin-host.ts'

const root = await mkdtemp(join(tmpdir(), 'imagine-example-plugin-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

const SOURCE = join('plugins', 'example-webhook', 'src', 'index.ts')

/** The plugins built once for the whole run (helpers/plugin-bundle.ts); every test waits for it. */
const built = builtPlugins()
/** The example's bundle, once the build is done. */
const bundlePath = async (): Promise<string> => bundleOf(await built, 'example-webhook')

/** The fake calls, so nothing goes to the internet. */
const network = fakeFetch((input, init) => ({
  url: String(input),
  body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
  headers: (init?.headers ?? {}) as Record<string, string>,
}))
const { calls } = network

function answerWith(handler: () => unknown): void {
  network.answerWith(() => handler())
}

/** The plugin installed in a throwaway data folder, with its bus. */
async function load(): Promise<{
  plugins: Plugins
  dir: string
  routes: { path: string; handler: (req: unknown, res: unknown) => unknown }[]
  bus: ReturnType<typeof fakePluginHost>['bus']
}> {
  return installPlugin(root, 'example-webhook', await bundlePath())
}

test('the source is in the repo, the bundle builds and imports only builtins', async () => {
  const source = await readFile(SOURCE, 'utf8')
  // An example to read: past a hundred-odd lines it is no longer an example.
  assert.ok(source.split('\n').length < 130, `source too long: ${String(source.split('\n').length)} lines`)
  const { stdout } = await built
  assert.match(stdout, /plugin example-webhook: index\.mjs/)
  const bundle = await bundlePath()
  const info = await stat(bundle)
  assert.ok(info.size > 1_000, 'the bundle exists')
  const text = await readFile(bundle, 'utf8')
  for (const line of text.split('\n').filter(line => line.startsWith('import '))) {
    assert.match(line, /from "node:/, `non-builtin import: ${line}`)
  }
  const module = await import(pathToFileURL(bundle).href) as { default?: unknown }
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
