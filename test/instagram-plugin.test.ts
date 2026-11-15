/**
 * The Instagram module loaded as a plugin: the publisher that used to be the
 * host's, now behind the contract.
 *
 * The test does not talk to Instagram: it builds the real bundle into a
 * temporary folder (`PLUGINS_OUT`, so the working tree is never rewritten),
 * loads it from there and gives it a fake context, as the loader does in
 * production.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { fakePluginHost } from './helpers/plugin-host.ts'

const { createPlugins } = await import('../server/src/plugins.ts')

const root = await mkdtemp(join(tmpdir(), 'imagine-instagram-plugin-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

const OUT = join(root, 'build')
const BUNDLE = join(OUT, 'instagram', 'index.mjs')

/** Builds the plugins once into the temporary folder; every test waits for it. */
const built = promisify(execFile)(process.execPath, ['scripts/build.mjs', 'plugins'], {
  timeout: 60_000,
  env: { ...process.env, PLUGINS_OUT: OUT },
})
// Observed here so a failed build is reported by the first test, not as an unhandled rejection.
built.catch(() => undefined)

/** The plugin loaded into a data folder that holds just this plugin. */
async function load(): Promise<{
  plugins: Awaited<ReturnType<typeof createPlugins>>
  dir: string
  routes: { path: string; kind: string }[]
  bus: ReturnType<typeof fakePluginHost>['bus']
}> {
  await built
  const dir = await mkdtemp(join(root, 'data-'))
  const folder = join(dir, 'instagram')
  // The loader wants the plugin's folder: the built bundle is copied there.
  const { mkdir, copyFile } = await import('node:fs/promises')
  await mkdir(folder, { recursive: true })
  await copyFile(join('plugins', 'instagram', 'manifest.json'), join(folder, 'manifest.json'))
  await copyFile(BUNDLE, join(folder, 'index.mjs'))
  const fake = fakePluginHost({ mediaDir: dir, model: { provider: 'omniroute', model: 'test/model' } })
  const { bus } = fake
  const routes = fake.routes as unknown as { path: string; kind: string }[]
  const plugins = await createPlugins({
    dir,
    host: fake.host,
  })
  await plugins.start()
  return { plugins, dir, routes, bus }
}

test('the Instagram module loads as a plugin, with its routes and its status', async () => {
  const { plugins, routes } = await load()
  const view = (await plugins.list())[0]!
  assert.equal(view.id, 'instagram')
  assert.equal(view.loaded, true, `not loaded: ${String(view.error)}`)
  assert.equal(view.compatible, true)
  // The routes live under the plugin's namespace.
  const social = routes.find(route => route.path === '/plugin/instagram/social')
  assert.ok(social !== undefined, 'the publisher prefix is registered')
  // Without a token the status says what is missing, and does not go to the network to say it.
  assert.equal(view.status?.ok, false)
  assert.equal(view.status?.summary?.it, 'token mancante')
  assert.equal(view.status?.summary?.en, 'token missing')
  const lines = (view.status?.lines ?? []).map(line => line.text.it).join(' | ')
  assert.match(lines, /token Instagram mancante/)
  assert.match(lines, /token dei commenti mancanti/)
  assert.match(lines, /pubblicazione automatica spenta/)
  // The three actions: one check (GET), two saves with password fields.
  assert.deepEqual(view.actions.map(action => action.key), ['verify-meta', 'save-token', 'save-comments'])
  assert.equal(view.actions[0]?.method, 'GET')
  assert.equal(view.actions[1]?.method, 'POST')
  assert.deepEqual((view.actions[1]?.fields ?? []).map(field => field.key), ['accessToken'])
  assert.deepEqual((view.actions[2]?.fields ?? []).map(field => field.key), ['pageAccessToken', 'userAccessToken'])
  // No token in the view (there are none, but the contract holds anyway).
  const json = JSON.stringify(view)
  // The prefix is assembled here too: a grep for secrets must stay empty.
  assert.equal(json.includes(['IG', 'AA'].join('')), false)
  plugins.dispose()
})

test('the plugin settings show up as fields, with empty defaults', async () => {
  const { plugins } = await load()
  const view = (await plugins.list())[0]!
  const keys = view.settings.map(setting => setting.key)
  assert.deepEqual(keys, [
    'scheduler', 'model', 'language', 'storiesFrom', 'commentHours', 'fixedHashtags', 'reelHashtags', 'franchiseHashtags',
    'instagramDir', 'scriptsDir', 'stateDir', 'watermark', 'watermarkText',
  ])
  const byKey = new Map(view.settings.map(setting => [setting.key, setting]))
  assert.equal(byKey.get('scheduler')?.kind, 'toggle')
  assert.equal(byKey.get('scheduler')?.value, false)
  assert.equal(byKey.get('instagramDir')?.value, '')
  // What the scheduler writes on its own stays Italian unless the owner picks English.
  assert.equal(byKey.get('language')?.kind, 'select')
  assert.equal(byKey.get('language')?.value, 'it')
  // The account's own values live in the installation's config.json, not in the manifest.
  assert.equal(byKey.get('storiesFrom')?.value, '')
  assert.equal(byKey.get('commentHours')?.value, '8, 14, 20')
  assert.equal(byKey.get('franchiseHashtags')?.value, '')
  assert.equal(byKey.get('fixedHashtags')?.value, '#krea2')
  assert.equal(byKey.get('reelHashtags')?.value, '#minimaxh3')
  // The mark is on by default, but says nothing until the owner writes its text.
  assert.equal(byKey.get('watermark')?.kind, 'toggle')
  assert.equal(byKey.get('watermark')?.value, true)
  assert.equal(byKey.get('watermarkText')?.value, '')
  assert.doesNotMatch(JSON.stringify(view), /\/(srv|root)\//, 'no deployment path in the defaults')
  plugins.dispose()
})

test('the publisher status reads the tokens from the file, without network', async () => {
  const { plugins, dir } = await load()
  const { mkdir, writeFile } = await import('node:fs/promises')
  const instagram = join(dir, 'instagram-data')
  await mkdir(join(instagram, 'config'), { recursive: true })
  await writeFile(join(instagram, 'config', 'api_token.json'), JSON.stringify({
    access_token: 'IG' + 'AA' + 'x'.repeat(150),
    obtained: new Date().toISOString(),
    expires_in: 60 * 24 * 60 * 60,
    username: 'prova',
    ig_user_id: '17840000000001789',
  }))
  await plugins.saveSettings('instagram', { instagramDir: instagram })
  const view = (await plugins.list())[0]!
  assert.equal(view.status?.ok, true)
  // 60 days declared: the count is in whole days, so 59 or 60.
  assert.match(view.status?.summary?.it ?? '', /^@prova · (59|60) giorni$/)
  assert.match(view.status?.summary?.en ?? '', /^@prova · (59|60) days$/)
  assert.match((view.status?.lines ?? [])[0]?.text.it ?? '', /@prova · (59|60) giorni/)
  // The token does not leave the status.
  assert.equal(JSON.stringify(view).includes('x'.repeat(150)), false)
  const config = await readFile(join(dir, 'instagram', 'config.json'), 'utf8')
  assert.equal(config.includes('instagram-data'), true, 'the saved path is the test one')
  plugins.dispose()
})

test('the plugin registers its scheduler as the plugin API tick, not a timer of its own', async () => {
  const { plugins } = await load()
  const view = (await plugins.list())[0]!
  assert.equal(view.loaded, true, `not loaded: ${String(view.error)}`)
  // With the scheduler off a tick does nothing, and must not throw.
  const bundle = await import(`${pathToFileURL(BUNDLE).href}?tick=${String(Date.now())}`) as {
    default: (ctx: unknown) => { tick?: (now: Date) => unknown; routes?: readonly { path: string }[] }
  }
  const setup = bundle.default({
    api: 1, id: 'instagram', dir: root, config: () => ({ scheduler: false }), dataPath: (...parts: string[]) => join(root, ...parts),
    comfy: {}, llm: {}, auxiliary: {}, model: () => ({ provider: 'p', model: 'm' }), mediaDir: root,
    notify: async () => undefined, onNotify: () => () => undefined, effect: () => undefined, registerRoute: () => () => undefined,
  })
  assert.equal(typeof setup.tick, 'function')
  assert.deepEqual((setup.routes ?? []).map(route => route.path), ['/plugin/instagram/social'])
  await setup.tick?.(new Date())
  plugins.dispose()
})

test('the settings parsers read hours, the hand-over day and the franchise table', async () => {
  const { parseCommentHours, parseStoriesFrom, parseFranchiseHashtags, DEFAULT_COMMENT_HOURS } = await import('../plugins/instagram/src/context.ts')
  assert.deepEqual(parseCommentHours('20, 8 14,8'), [8, 14, 20])
  assert.deepEqual(parseCommentHours(''), DEFAULT_COMMENT_HOURS)
  assert.deepEqual(parseCommentHours('25, x'), DEFAULT_COMMENT_HOURS)
  assert.equal(parseStoriesFrom(' 2026-09-14 '), '2026-09-14')
  assert.equal(parseStoriesFrom(''), undefined)
  assert.equal(parseStoriesFrom('14/09/2026'), undefined)
  assert.deepEqual(parseFranchiseHashtags('Sailor Moon: #SailorMoon #SailorMoonCosplay; d.va: #DVa #Overwatch;bad;x: #only'), [
    ['sailor moon', '#SailorMoon', '#SailorMoonCosplay'],
    ['d.va', '#DVa', '#Overwatch'],
  ])
})
