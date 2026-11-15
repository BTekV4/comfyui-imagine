/**
 * The plugin system: loading, contract, config and fault isolation.
 *
 * The rule that matters most is the first: a broken plugin must not bring the
 * server down. An `import` that throws, a `setup` that throws and a `tick`
 * that throws are the plugin's incidents, not the studio's.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakePluginHost } from './helpers/plugin-host.ts'
import { writePlugin } from './helpers/plugin-files.ts'

const { createPlugins } = await import('../server/src/plugins.ts')

const root = await mkdtemp(join(tmpdir(), 'imagine-plugins-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

/** A system with its folder and its fake host. */
async function system(tickMs?: number, statusTimeoutMs?: number): Promise<{
  plugins: Awaited<ReturnType<typeof createPlugins>>
  dir: string
  host: ReturnType<typeof fakePluginHost>
}> {
  const dir = await mkdtemp(join(root, 'data-'))
  const host = fakePluginHost({ mediaDir: dir })
  const plugins = await createPlugins({
    dir,
    host: host.host,
    ...tickMs === undefined ? {} : { tickMs },
    ...statusTimeoutMs === undefined ? {} : { statusTimeoutMs },
  })
  return { plugins, dir, host }
}

/** Writes a plugin into `<dir>/<id>`: manifest + module (helpers/plugin-files.ts). */
async function plugin(dir: string, id: string, options: Parameters<typeof writePlugin>[2] = {}): Promise<string> {
  const folder = join(dir, id)
  await writePlugin(folder, id, options)
  return folder
}

test('a valid plugin loads: name, version, fields and status', async () => {
  const { plugins, dir } = await system()
  await plugin(dir, 'webhook', {
    settings: [
      { key: 'url', kind: 'text', label: { en: 'Address', it: 'Indirizzo' }, placeholder: 'https://…', default: 'https://example.test' },
      { key: 'enabled', kind: 'toggle', label: { en: 'Enabled', it: 'Attivo' }, default: false },
      { key: 'mode', kind: 'select', label: { en: 'Mode', it: 'Modo' }, options: [{ value: 'a', label: { en: 'A', it: 'A' } }] },
    ],
    module: 'export default function setup() { return { status: () => ({ ok: true, summary: "pronto" }) } }\n',
  })
  await plugins.start()
  const list = await plugins.list()
  assert.equal(list.length, 1)
  const view = list[0]!
  assert.equal(view.id, 'webhook')
  assert.equal(view.name, 'WEBHOOK')
  assert.equal(view.version, '1.0.0')
  assert.equal(view.api, 1)
  assert.equal(view.compatible, true)
  assert.equal(view.loaded, true)
  assert.equal(view.error, null)
  assert.equal(view.status?.ok, true)
  assert.equal(view.status?.summary?.en, 'pronto')
  assert.deepEqual(view.settings.map(setting => setting.key), ['url', 'enabled', 'mode'])
  assert.equal(view.settings[0]?.value, 'https://example.test', 'the default applies until there is a config')
  assert.equal(view.settings[1]?.value, false)
  plugins.dispose()
})

test('bad manifests: invalid id, api 2, escaping entry, missing entry, broken JSON', async () => {
  const { plugins, dir } = await system()
  await plugin(dir, 'maiuscoletto', { manifest: { id: 'Maiuscoletto' } })
  await plugin(dir, 'vecchio', { manifest: { api: 2 } })
  await plugin(dir, 'fuggitivo', { manifest: { entry: '../evil.mjs' }, module: 'export default () => ({})\n' })
  await plugin(dir, 'senza-file', { manifest: { entry: 'manca.mjs' }, module: 'export default () => ({})\n' })
  const broken = join(dir, 'json-rotto')
  await mkdir(broken, { recursive: true })
  await writeFile(join(broken, 'manifest.json'), '{ non json')
  await plugins.start()
  const byId = new Map((await plugins.list()).map(entry => [entry.id, entry]))
  assert.match(byId.get('maiuscoletto')?.error ?? '', /id/)
  assert.equal(byId.get('maiuscoletto')?.loaded, false)
  assert.equal(byId.get('vecchio')?.compatible, false)
  assert.equal(byId.get('vecchio')?.loaded, false)
  assert.match(byId.get('fuggitivo')?.error ?? '', /entry/)
  assert.match(byId.get('senza-file')?.error ?? '', /not a file/)
  assert.equal(byId.get('json-rotto')?.loaded, false)
  assert.ok((byId.get('json-rotto')?.error ?? '').length > 0)
  plugins.dispose()
})

test('a plugin that throws on import does not stop the others or bring the system down', async () => {
  const { plugins, dir } = await system()
  await plugin(dir, 'rotto', { module: 'throw new Error("boom all’import")\n' })
  await plugin(dir, 'sano', { module: 'export default function setup() { return { status: () => ({ ok: true }) } }\n' })
  await plugins.start()
  const byId = new Map((await plugins.list()).map(entry => [entry.id, entry]))
  assert.equal(byId.get('rotto')?.loaded, false)
  assert.match(byId.get('rotto')?.error ?? '', /boom all’import/)
  assert.equal(byId.get('sano')?.loaded, true)
  plugins.dispose()
})

test('a setup that throws leaves the plugin listed with the error, and half-registered routes go away', async () => {
  const { plugins, dir, host } = await system()
  await plugin(dir, 'meta-rotto', {
    module: `export default function setup(ctx) {
      ctx.registerRoute({ path: '/plugin/meta-rotto/prima', handler: () => undefined })
      throw new Error('boom nel setup')
    }
`,
  })
  await plugin(dir, 'sano', { module: 'export default () => ({})\n' })
  await plugins.start()
  const byId = new Map((await plugins.list()).map(entry => [entry.id, entry]))
  assert.match(byId.get('meta-rotto')?.error ?? '', /boom nel setup/)
  assert.equal(byId.get('meta-rotto')?.loaded, false)
  assert.equal(host.routes.some(route => route.path.startsWith('/plugin/meta-rotto/')), false, 'the route registered before the throw is removed')
  assert.equal(byId.get('sano')?.loaded, true)
  plugins.dispose()
})

test('a route outside /plugin/<id>/ is refused', async () => {
  const { plugins, dir, host } = await system()
  await plugin(dir, 'invasore', {
    module: 'export default (ctx) => ({ routes: [{ path: "/api/host-settings", handler: () => undefined }] })\n',
  })
  await plugins.start()
  const view = (await plugins.list())[0]!
  assert.equal(view.loaded, false)
  assert.match(view.error ?? '', /outside \/plugin\/invasore\//)
  assert.equal(host.routes.length, 0)
  plugins.dispose()
})

test('a plugin may mount a web app under /apps/<id>, and only its own', async () => {
  const { plugins, dir, host } = await system()
  await plugin(dir, 'app-mia', {
    module: 'export default () => ({ routes: [{ path: "/apps/app-mia", kind: "prefix", handler: () => undefined }] })\n',
  })
  await plugin(dir, 'app-ladra', {
    module: 'export default () => ({ routes: [{ path: "/apps/app-mia-bis", kind: "prefix", handler: () => undefined }] })\n',
  })
  await plugins.start()
  const views = new Map((await plugins.list()).map(view => [view.id, view]))
  assert.equal(views.get('app-mia')?.loaded, true)
  assert.equal(views.get('app-ladra')?.loaded, false, '/apps/app-mia-bis is not /apps/app-ladra')
  assert.deepEqual(host.routes.map(route => route.path), ['/apps/app-mia'])
  plugins.dispose()
})

test('a tick that throws does not stop the other ticks', async () => {
  const { plugins, dir } = await system(20)
  await plugin(dir, 'cattivo', {
    module: 'export default () => ({ tick: () => { throw new Error("tick rotto") } })\n',
  })
  await plugin(dir, 'buono', {
    module: `import { appendFileSync } from 'node:fs'
export default (ctx) => ({ tick: () => { appendFileSync(ctx.dataPath('tick.log'), 'x\\n') } })
`,
  })
  await plugins.start()
  await new Promise(resolve => setTimeout(resolve, 120))
  const lines = (await readFile(join(dir, 'buono', 'tick.log'), 'utf8')).trim().split('\n')
  assert.ok(lines.length >= 2, `the good tick must run, lines: ${String(lines.length)}`)
  assert.equal((await plugins.list()).find(entry => entry.id === 'cattivo')?.loaded, true)
  plugins.dispose()
})

test('a reload does not stop the tick', async () => {
  const { plugins, dir } = await system(20)
  await plugin(dir, 'vivo', {
    module: `import { appendFileSync } from 'node:fs'
export default (ctx) => ({ tick: () => { appendFileSync(ctx.dataPath('tick.log'), 'x\\n') } })
`,
  })
  const file = join(dir, 'vivo', 'tick.log')
  /** How many lines the file has, waiting for at least `wanted` to arrive. */
  const lines = async (wanted: number): Promise<number> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const count = await readFile(file, 'utf8').then(text => text.trim().split('\n').length, () => 0)
      if (count >= wanted) return count
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return readFile(file, 'utf8').then(text => text.trim().split('\n').length, () => 0)
  }
  await plugins.start()
  const loaded = (await plugins.list())[0]
  assert.equal(loaded?.loaded, true, `the test plugin must load: ${String(loaded?.error)}`)
  const first = await lines(1)
  assert.ok(first >= 1, 'the tick must start on its own')
  await plugins.refresh('vivo')
  const second = await lines(first + 1)
  assert.ok(second > first, `after the refresh the tick must keep going: ${String(first)} -> ${String(second)}`)
  plugins.dispose()
})

test('a status that throws or does not answer is the plugin\'s fault, not the page\'s', async () => {
  const { plugins, dir } = await system(undefined, 30)
  await plugin(dir, 'lento', { module: 'export default () => ({ status: () => new Promise(() => {}) })\n' })
  await plugin(dir, 'lancia', { module: 'export default () => ({ status: () => { throw new Error("stato rotto") } })\n' })
  await plugins.start()
  const byId = new Map((await plugins.list()).map(entry => [entry.id, entry]))
  assert.equal(byId.get('lento')?.status?.ok, false)
  assert.match(byId.get('lento')?.status?.detail?.en ?? '', /non ha risposto|did not answer/)
  assert.equal(byId.get('lancia')?.status?.ok, false)
  assert.match(byId.get('lancia')?.status?.detail?.en ?? '', /stato rotto/)
  plugins.dispose()
})

test('the config is written atomically, 0600, with a backup; and the password is never read back', async () => {
  const { plugins, dir } = await system()
  await plugin(dir, 'webhook', {
    settings: [
      { key: 'url', kind: 'text', label: { en: 'Address', it: 'Indirizzo' } },
      { key: 'secret', kind: 'password', label: { en: 'Secret', it: 'Segreto' } },
      { key: 'enabled', kind: 'toggle', label: { en: 'Enabled', it: 'Attivo' } },
    ],
  })
  await plugins.start()
  const first = await plugins.saveSettings('webhook', { url: 'https://a.test', secret: 's3gr3to', enabled: true })
  assert.equal(first.backup, null, 'the first save has nothing to back up')
  const file = join(dir, 'webhook', 'config.json')
  const info = await stat(file)
  assert.equal(info.mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { url: 'https://a.test', secret: 's3gr3to', enabled: true })
  const second = await plugins.saveSettings('webhook', { url: 'https://b.test' })
  assert.ok(second.backup !== null)
  assert.equal(await readFile(second.backup, 'utf8'), '{\n  "url": "https://a.test",\n  "secret": "s3gr3to",\n  "enabled": true\n}\n')
  const view = (await plugins.list())[0]!
  const secret = view.settings.find(setting => setting.key === 'secret')
  assert.equal(secret?.value, null, 'the password never comes back')
  assert.equal(secret?.isSet, true)
  assert.equal(JSON.stringify(view).includes('s3gr3to'), false)
  assert.equal(view.settings.find(setting => setting.key === 'url')?.value, 'https://b.test')
  plugins.dispose()
})

test('at most five config backups', async () => {
  const { plugins, dir } = await system()
  await plugin(dir, 'webhook', { settings: [{ key: 'url', kind: 'text', label: { en: 'U', it: 'U' } }] })
  await plugins.start()
  for (let i = 0; i < 8; i += 1) await plugins.saveSettings('webhook', { url: `https://${String(i)}.test` })
  const copies = (await readdir(join(dir, 'webhook'))).filter(name => name.startsWith('config.json.bak-'))
  assert.equal(copies.length, 5)
  plugins.dispose()
})

test('values are validated against the manifest', async () => {
  const { plugins, dir } = await system()
  await plugin(dir, 'webhook', {
    settings: [
      { key: 'enabled', kind: 'toggle', label: { en: 'E', it: 'E' } },
      { key: 'mode', kind: 'select', label: { en: 'M', it: 'M' }, options: [{ value: 'a', label: { en: 'A', it: 'A' } }] },
      { key: 'url', kind: 'text', label: { en: 'U', it: 'U' } },
    ],
  })
  await plugins.start()
  await assert.rejects(plugins.saveSettings('webhook', { enabled: 'sì' }), /booleano|boolean/)
  await assert.rejects(plugins.saveSettings('webhook', { mode: 'z' }), /uno di|one of/)
  await assert.rejects(plugins.saveSettings('webhook', { url: 42 }), /stringa|string/)
  await assert.rejects(plugins.saveSettings('webhook', { sconosciuta: 'x' }), /non ha il campo|has no/)
  await assert.rejects(plugins.saveSettings('assente', { url: 'x' }), /sconosciuto|unknown/)
  await assert.rejects(plugins.saveSettings('webhook', undefined), /values|oggetto/)
  assert.deepEqual((await readdir(join(dir, 'webhook'))).filter(name => name === 'config.json'), [], 'nothing is written when refused')
  plugins.dispose()
})

test('ctx.config() reads the current values: a save arrives without reloading', async () => {
  const { plugins, dir, host } = await system()
  await plugin(dir, 'vivo', {
    settings: [{ key: 'url', kind: 'text', label: { en: 'U', it: 'U' }, default: 'https://prima.test' }],
    module: `import { writeFileSync } from 'node:fs'
export default (ctx) => ({
  routes: [{ path: '/plugin/vivo/leggi', handler: () => { writeFileSync(ctx.dataPath('letto.txt'), String(ctx.config().url)) } }],
})
`,
  })
  await plugins.start()
  const route = host.routes.find(entry => entry.path === '/plugin/vivo/leggi')
  assert.ok(route !== undefined)
  // Before the save: the default.
  await route.handler({} as never, {} as never)
  assert.equal(await readFile(join(dir, 'vivo', 'letto.txt'), 'utf8'), 'https://prima.test')
  // After: the new value, without reloading the module.
  await plugins.saveSettings('vivo', { url: 'https://dopo.test' })
  await route.handler({} as never, {} as never)
  assert.equal(await readFile(join(dir, 'vivo', 'letto.txt'), 'utf8'), 'https://dopo.test')
  plugins.dispose()
})

test('a plugin subscribes to the bus, and a reload unsubscribes the old one', async () => {
  const { plugins, dir, host } = await system()
  await plugin(dir, 'ascolta', {
    module: `export default (ctx) => {
  ctx.onNotify((text) => { ctx.log('ricevuto: ' + text) })
  return {}
}
`,
  })
  await plugins.start()
  assert.equal(host.bus.size, 1, 'the subscription belongs to the plugin')
  await plugins.refresh('ascolta')
  assert.equal(host.bus.size, 1, 'after the reload there is one subscription, not two')
  plugins.dispose()
  assert.equal(host.bus.size, 0, 'disposing of the system removes the subscriptions')
})

test('a plugin does not receive its own notices, and an action route outside its namespace is refused', async () => {
  const { plugins, dir, host } = await system()
  await plugin(dir, 'chiacchiera', {
    module: `export default (ctx) => {
  ctx.onNotify(() => { globalThis.__ricevuti = (globalThis.__ricevuti ?? 0) + 1 })
  return {}
}
`,
  })
  await plugin(dir, 'azione-invasiva', {
    manifest: { actions: [{ key: 'go', label: { en: 'Go', it: 'Via' }, path: '/comfy-plugins' }] },
  })
  await plugins.start()
  const byId = new Map((await plugins.list()).map(entry => [entry.id, entry]))
  assert.equal(byId.get('azione-invasiva')?.loaded, false)
  assert.match(byId.get('azione-invasiva')?.error ?? '', /actions|action "go" must call a path/)
  // A notice sent by the plugin itself does not come back to it.
  const before = (globalThis as { __ricevuti?: number }).__ricevuti ?? 0
  await host.bus.notify('mio', 'chiacchiera')
  assert.equal((globalThis as { __ricevuti?: number }).__ricevuti ?? 0, before)
  await host.bus.notify('altrui')
  assert.equal((globalThis as { __ricevuti?: number }).__ricevuti ?? 0, before + 1)
  delete (globalThis as { __ricevuti?: number }).__ricevuti
  plugins.dispose()
})

test('no plugins: empty list and no routes', async () => {
  const { plugins, host } = await system()
  await plugins.start()
  assert.deepEqual(await plugins.list(), [])
  assert.equal(host.routes.length, 0)
  plugins.dispose()
})

test('dataPath does not leave the plugin folder', async () => {
  const { plugins, dir } = await system()
  await plugin(dir, 'curioso', {
    module: `import { writeFileSync } from 'node:fs'
export default (ctx) => {
  const result = { escape: 'no' }
  try { ctx.dataPath('../fuori.txt') } catch (error) { result.escape = error.message }
  writeFileSync(ctx.dataPath('esito.json'), JSON.stringify(result))
  return {}
}
`,
  })
  await plugins.start()
  const result = JSON.parse(await readFile(join(dir, 'curioso', 'esito.json'), 'utf8')) as { escape: string }
  assert.match(result.escape, /escapes the plugin folder/)
  assert.equal((await plugins.list())[0]?.loaded, true)
  plugins.dispose()
})
