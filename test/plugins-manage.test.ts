/**
 * The plugins page, from the engine side: enabling and disabling, installing
 * from the repository, uninstalling without deleting, and status lines in both
 * languages.
 *
 * These are the commands the page calls; the drawing is not tested here.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakePluginHost } from './helpers/plugin-host.ts'
import { writePlugin } from './helpers/plugin-files.ts'

const { createPlugins } = await import('../server/src/plugins.ts')

const root = await mkdtemp(join(tmpdir(), 'imagine-plugins-manage-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

/** A system with a data folder, a repository and a state file, all temporary. */
async function system(): Promise<{
  plugins: Awaited<ReturnType<typeof createPlugins>>
  dir: string
  repo: string
  stateFile: string
  routes: { path: string }[]
}> {
  const base = await mkdtemp(join(root, 'case-'))
  const dir = join(base, 'data', 'plugins')
  const repo = join(base, 'repo', 'plugins')
  const stateFile = join(base, 'data', 'plugins-state.json')
  await mkdir(dir, { recursive: true })
  await mkdir(repo, { recursive: true })
  const fake = fakePluginHost({ mediaDir: base, model: { provider: 'prova', model: 'prova' } })
  const routes = fake.routes
  const plugins = await createPlugins({
    dir,
    repoDir: repo,
    stateFile,
    host: fake.host,
  })
  return { plugins, dir, repo, stateFile, routes }
}

/** A plugin in a folder: manifest + module (helpers/plugin-files.ts). */
const plugin = writePlugin

test('plugins-state.json: disabled means listed and not loaded, and the choice persists', async () => {
  const { plugins, dir, stateFile, routes } = await system()
  await plugin(join(dir, 'webhook'), 'webhook', {
    module: 'export default () => ({ routes: [{ path: "/plugin/webhook/x", handler: () => undefined }] })\n',
  })
  await plugins.start()
  assert.equal((await plugins.list())[0]?.enabled, true)
  assert.equal(routes.length, 1)

  // Disabled from the page: it stays in the list and registers nothing.
  const off = await plugins.setEnabled('webhook', false)
  assert.equal(off.enabled, false)
  assert.equal(off.loaded, false)
  assert.equal(routes.length, 0, 'disabling it removes its routes')
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { disabled: ['webhook'] })
  plugins.dispose()

  // A new process reads the state and leaves it disabled.
  const again = await createPlugins({
    dir,
    stateFile,
    host: fakePluginHost({ mediaDir: dir, model: { provider: 'p', model: 'm' } }).host,
  })
  await again.start()
  const kept = (await again.list())[0]!
  assert.equal(kept.enabled, false)
  assert.equal(kept.loaded, false)
  assert.equal(kept.error, null, 'disabled is not broken')
  // And enabling it again loads it.
  assert.equal((await again.setEnabled('webhook', true)).loaded, true)
  again.dispose()
})

test('available lists the repository plugins, install copies and loads them', async () => {
  const { plugins, dir, repo } = await system()
  await plugin(join(repo, 'example-webhook'), 'example-webhook', {
    manifest: { name: 'Example webhook', description: { en: 'Forwards.', it: 'Inoltra.' }, icon: '🔗' },
    module: 'export default () => ({ routes: [{ path: "/plugin/example-webhook/test", handler: () => undefined }] })\n',
  })
  await plugins.start()
  const available = await plugins.available()
  assert.deepEqual(available.map(entry => entry.id), ['example-webhook'])
  assert.equal(available[0]?.icon, '🔗')
  assert.equal(available[0]?.compatible, true)

  const installed = await plugins.install('example-webhook')
  assert.equal(installed.installed, true)
  assert.equal(installed.loaded, true)
  assert.equal(installed.icon, '🔗')
  assert.deepEqual((await plugins.available()).map(entry => entry.id), [], 'once installed it is no longer available')
  assert.deepEqual((await readdir(dir)).sort(), ['example-webhook'])
  assert.equal((await readFile(join(dir, 'example-webhook', 'index.mjs'), 'utf8')).includes('/plugin/example-webhook/test'), true)
  plugins.dispose()
})

test('at start an installed plugin is brought up to the repository copy, its settings untouched', async () => {
  const { plugins, dir, repo } = await system()
  await plugin(join(dir, 'webhook'), 'webhook', { manifest: { version: '1.0.0' }, module: 'export default () => ({})\n' })
  await writeFile(join(dir, 'webhook', 'config.json'), '{"url":"https://mine.example"}\n')
  await plugin(join(repo, 'webhook'), 'webhook', { manifest: { version: '1.1.0' }, module: 'export default () => ({ status: () => ({ ok: true }) })\n' })
  // Installed by hand, not shipped by the repository: left alone.
  await plugin(join(dir, 'mine'), 'mine', { module: 'export default () => ({})\n' })
  await plugins.start()
  const views = new Map((await plugins.list()).map(view => [view.id, view]))
  assert.equal(views.get('webhook')?.version, '1.1.0')
  assert.equal(views.get('webhook')?.loaded, true)
  assert.equal(await readFile(join(dir, 'webhook', 'config.json'), 'utf8'), '{"url":"https://mine.example"}\n')
  const kept = (await readdir(join(dir, 'webhook'))).filter(name => name.includes('.bak-') && name.endsWith('-update'))
  assert.equal(kept.length, 2, `old manifest and entry kept: ${kept.join(', ')}`)
  assert.equal(views.get('mine')?.loaded, true)
  plugins.dispose()
  // Nothing changed since: a second start copies nothing.
  const again = await createPlugins({ dir, repoDir: repo, host: fakePluginHost({ mediaDir: dir }).host })
  await again.start()
  assert.equal((await readdir(join(dir, 'webhook'))).filter(name => name.endsWith('-update')).length, 2)
  again.dispose()
})

test('install rejects an id not in the repository, and no paths', async () => {
  const { plugins, repo, dir } = await system()
  await plugin(join(repo, 'vero'), 'vero')
  await plugins.start()
  for (const bad of ['../../etc', 'nope', 'Vero', '', 'inesistente']) {
    await assert.rejects(plugins.install(bad), /repository has no plugin|repository non ha un plugin/, `accepted: ${bad}`)
  }
  assert.deepEqual(await readdir(dir), [])
  // A repository plugin with a different API version does not install.
  await plugin(join(repo, 'vecchio'), 'vecchio', { manifest: { api: 2 } })
  await assert.rejects(plugins.install('vecchio'), /speaks API 2|parla l'API 2/)
  assert.deepEqual(await readdir(dir), [])
  plugins.dispose()
})

test('remove moves the folder to plugins-rimossi and drops it from the list', async () => {
  const { plugins, dir } = await system()
  await plugin(join(dir, 'webhook'), 'webhook')
  await plugins.start()
  const { movedTo } = await plugins.remove('webhook')
  assert.match(movedTo, /plugins-rimossi[\\/]webhook-/)
  assert.equal(await stat(movedTo).then(info => info.isDirectory(), () => false), true, 'the folder was moved, not deleted')
  assert.equal(await stat(join(dir, 'webhook')).then(() => true, () => false), false)
  assert.deepEqual(await plugins.list(), [])
  plugins.dispose()
})

test('reloading finds a new folder and forgets a vanished one', async () => {
  const { plugins, dir } = await system()
  await plugin(join(dir, 'uno'), 'uno')
  await plugins.start()
  assert.deepEqual((await plugins.list()).map(entry => entry.id), ['uno'])
  // Copied by hand, without restarting: the button must find it.
  await plugin(join(dir, 'due'), 'due')
  await plugins.reloadAll()
  assert.deepEqual((await plugins.list()).map(entry => entry.id), ['due', 'uno'])
  // And a folder removed by hand must leave the list.
  await rm(join(dir, 'uno'), { recursive: true, force: true })
  await plugins.reloadAll()
  assert.deepEqual((await plugins.list()).map(entry => entry.id), ['due'])
  plugins.dispose()
})

test('status lines can be written in both languages', async () => {
  const { plugins, dir } = await system()
  await plugin(join(dir, 'bilingue'), 'bilingue', {
    module: `export default () => ({
  status: () => ({
    ok: true,
    summary: { en: 'connected', it: 'collegato' },
    lines: [
      { text: { en: 'two tokens', it: 'due token' }, tone: 'ok' },
      { text: 'una sola lingua' },
      { text: 42 },
    ],
  }),
})
`,
  })
  await plugins.start()
  const status = (await plugins.list())[0]?.status
  assert.deepEqual(status?.summary, { en: 'connected', it: 'collegato' })
  assert.deepEqual(status?.lines?.map(line => line.text), [
    { en: 'two tokens', it: 'due token' },
    { en: 'una sola lingua', it: 'una sola lingua' },
  ])
  assert.equal(status?.lines?.[0]?.tone, 'ok')
  plugins.dispose()
})

test('the manifest icon reaches the page, and one that is too long is cut', async () => {
  const { plugins, dir } = await system()
  await plugin(join(dir, 'con-icona'), 'con-icona', { manifest: { icon: '✈️' } })
  await plugin(join(dir, 'icona-lunga'), 'icona-lunga', { manifest: { icon: 'questo-non-e-un-glifo' } })
  await plugin(join(dir, 'senza-icona'), 'senza-icona')
  await plugins.start()
  const byId = new Map((await plugins.list()).map(entry => [entry.id, entry]))
  assert.equal(byId.get('con-icona')?.icon, '✈️')
  assert.equal(Array.from(byId.get('icona-lunga')?.icon ?? '').length, 4)
  assert.equal(byId.get('senza-icona')?.icon, null)
  plugins.dispose()
})

test('the deploy update replaces the changed files with a -deploy backup and reloads what it updated', async () => {
  const { plugins, dir, repo } = await system()
  await plugin(join(dir, 'webhook'), 'webhook', { manifest: { version: '1.0.0' } })
  await plugin(join(repo, 'webhook'), 'webhook', { manifest: { version: '1.0.0' } })
  // Shipped, but its entry is not built: reported, left as installed.
  await plugin(join(dir, 'broken'), 'broken')
  await plugin(join(repo, 'broken'), 'broken')
  await rm(join(repo, 'broken', 'index.mjs'))
  await plugins.start()
  assert.deepEqual((await plugins.updateFromRepo({ tag: 'deploy', reload: true })).updated, [], 'nothing changed yet')

  await plugin(join(repo, 'webhook'), 'webhook', { manifest: { version: '1.2.0' }, module: 'export default () => ({ status: () => ({ ok: true }) })\n' })
  const answer = await plugins.updateFromRepo({ tag: 'deploy', reload: true })
  assert.deepEqual(answer.updated, ['webhook'])
  assert.deepEqual(answer.reloaded, ['webhook'])
  assert.deepEqual(answer.invalid, ['broken'])
  assert.match(answer.backupSuffix, /^\.bak-.+-deploy$/)
  assert.equal(new Map((await plugins.list()).map(view => [view.id, view])).get('webhook')?.version, '1.2.0', 'reloaded at once')
  const names = await readdir(join(dir, 'webhook'))
  assert.deepEqual(names.filter(name => name.endsWith('-deploy')).sort(), [`index.mjs${answer.backupSuffix}`, `manifest.json${answer.backupSuffix}`])
  assert.equal(names.some(name => name.endsWith('.tmp')), false, 'no temp file left behind')

  // Without reload (a restart follows): copied, not reloaded.
  await plugin(join(repo, 'webhook'), 'webhook', { manifest: { version: '1.3.0' } })
  const quiet = await plugins.updateFromRepo({ tag: 'deploy', reload: false })
  assert.deepEqual(quiet.updated, ['webhook'])
  assert.deepEqual(quiet.reloaded, [])
  assert.equal(JSON.parse(await readFile(join(dir, 'webhook', 'manifest.json'), 'utf8')).version, '1.3.0')
  plugins.dispose()
})
