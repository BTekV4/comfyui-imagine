/**
 * The Telegram plugin: listens to the bus, sends, and never leaks the token.
 *
 * The module is the one installed in `<data>/plugins/telegram/`: the test loads
 * it from the same tree (`plugins/telegram/`) into a temporary folder, so what
 * is tested is the file the user copies.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { fakePluginHost } from './helpers/plugin-host.ts'
import { fakeFetch } from './helpers/fake-fetch.ts'
import { fakeRequest, fakeResponse } from './helpers/fake-http.ts'
import { installPlugin, type Plugins } from './helpers/plugin-files.ts'

const root = await mkdtemp(join(tmpdir(), 'imagine-telegram-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

const TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abcde'
const CHAT = '1234567890'

/** The fake calls to Telegram, instead of the network. */
const network = fakeFetch((input, init) => ({
  url: String(input),
  body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {},
}))
const { calls } = network

/** A Telegram answer. */
function telegramSays(ok: boolean, payload: Record<string, unknown>): unknown {
  return { ok, status: ok ? 200 : 400, json: async () => payload }
}

/** Answers like Telegram: ok, or refuses with a description. */
function answerWith(handler: (body: Record<string, unknown>) => unknown): void {
  network.answerWith(call => handler(call.body))
}

/** The plugin installed in a temporary folder, with its bus: the repository's own hand-written module. */
async function install(): Promise<{
  plugins: Plugins
  bus: ReturnType<typeof fakePluginHost>['bus']
  dir: string
  routes: { path: string; handler: (req: unknown, res: unknown) => unknown }[]
}> {
  return installPlugin(root, 'telegram', join('plugins', 'telegram', 'index.mjs'), { notifyTimeoutMs: 1000 })
}

test('without a token the status says what is missing, and the test action is a 400', async () => {
  answerWith(() => telegramSays(true, { ok: true, result: { message_id: 1 } }))
  const { plugins, routes } = await install()
  const view = (await plugins.list())[0]!
  assert.equal(view.loaded, true)
  assert.deepEqual(view.status, { ok: false, summary: { en: 'token missing', it: 'token mancante' } })
  assert.deepEqual(view.actions.map(action => action.key), ['test'])
  const response = fakeResponse()
  await routes[0]!.handler(fakeRequest(), response)
  assert.equal(response.statusCode, 400)
  assert.equal(calls.length, 0, 'without configuration Telegram is not called')
  assert.equal(JSON.stringify(view).includes(TOKEN), false)
  plugins.dispose()
})

test('with token and chat the status is ok, with the chat masked and never the token', async () => {
  const { plugins } = await install()
  await plugins.saveSettings('telegram', { botToken: TOKEN, chatId: CHAT })
  const view = (await plugins.list())[0]!
  assert.equal(view.status?.ok, true)
  assert.equal(view.status?.summary?.it, 'collegato a 1234…890')
  assert.equal(view.status?.summary?.en, 'connected to 1234…890')
  const json = JSON.stringify(view)
  assert.equal(json.includes(TOKEN), false, 'the token never leaves')
  // The chat is a `text` field: the panel shows it, and that is fine — it is
  // not a secret. It is the STATUS that masks it.
  assert.equal(view.settings.find(setting => setting.key === 'chatId')?.value, CHAT)
  assert.equal((view.status?.summary?.en ?? '').includes(CHAT), false, 'the status does not repeat the whole chat')
  plugins.dispose()
})

test('"Send a test" sends a line and reports the message_id', async () => {
  answerWith(() => telegramSays(true, { ok: true, result: { message_id: 4242 } }))
  const { plugins, routes, dir } = await install()
  await plugins.saveSettings('telegram', { botToken: TOKEN, chatId: CHAT })
  const response = fakeResponse()
  await routes[0]!.handler(fakeRequest(), response)
  assert.equal(response.statusCode, 200)
  const answer = JSON.parse(response.body) as { ok: boolean; messageId: number; chatId: string; elapsedMs: number }
  assert.equal(answer.ok, true)
  assert.equal(answer.messageId, 4242)
  assert.equal(answer.chatId, '1234…890')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`)
  assert.equal(calls[0]?.body['chat_id'], CHAT)
  assert.match(String(calls[0]?.body['text']), /prova/i)
  // The config necessarily contains the token (the plugin must use it): the
  // test checks that it is NOT in the route's answer and that the file is 0600.
  assert.equal(response.body.includes(TOKEN), false)
  const info = await stat(join(dir, 'telegram', 'config.json'))
  // POSIX permission bits; Windows keeps the file inside the user's profile.
  if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600)
  plugins.dispose()
})

test('a notice on the bus reaches the plugin, which sends it', async () => {
  answerWith(() => telegramSays(true, { ok: true, result: { message_id: 7 } }))
  const { plugins, bus, dir } = await install()
  await plugins.saveSettings('telegram', { botToken: TOKEN, chatId: CHAT })
  await bus.notify('⚠️ Scheduled post: publishing failed')
  assert.equal(calls.length, 1)
  assert.match(String(calls[0]?.body['text']), /publishing failed/)
  void dir
  plugins.dispose()
})

test('Telegram refusing: the test action is a 502 with the reason, and no token in the message', async () => {
  answerWith(() => telegramSays(false, { ok: false, description: 'Bad Request: chat not found' }))
  const { plugins, routes } = await install()
  await plugins.saveSettings('telegram', { botToken: TOKEN, chatId: CHAT })
  const response = fakeResponse()
  await routes[0]!.handler(fakeRequest(), response)
  assert.equal(response.statusCode, 502)
  const answer = JSON.parse(response.body) as { ok: boolean; error: string }
  assert.equal(answer.ok, false)
  assert.match(answer.error, /chat not found/)
  assert.equal(response.body.includes(TOKEN), false)
  plugins.dispose()
})

test('the plugin does not receive its own notices', async () => {
  answerWith(() => telegramSays(true, { ok: true, result: { message_id: 1 } }))
  const { plugins, bus } = await install()
  await plugins.saveSettings('telegram', { botToken: TOKEN, chatId: CHAT })
  // The plugin sends a notice: the bus must not hand it back to the plugin.
  await bus.notify('note from the plugin', 'telegram')
  assert.equal(calls.length, 0)
  plugins.dispose()
})

test('the migrated token stays identical: sha256 before and after the save', async () => {
  const { plugins, dir } = await install()
  // The source: a file like the one the installation had before the plugin
  // (`{ "token": … }`), read without printing it.
  const legacy = join(dir, 'telegram-bot.json')
  await writeFile(legacy, JSON.stringify({ token: TOKEN }), { mode: 0o600 })
  const before = createHash('sha256').update(TOKEN).digest('hex')
  const token = (JSON.parse(await readFile(legacy, 'utf8')) as { token: string }).token
  await plugins.saveSettings('telegram', { botToken: token, chatId: CHAT })
  const stored = JSON.parse(await readFile(join(dir, 'telegram', 'config.json'), 'utf8')) as { botToken: string }
  const after = createHash('sha256').update(stored.botToken).digest('hex')
  assert.equal(after, before, 'the migrated token is the same, byte for byte')
  plugins.dispose()
})

test('a notice with a picture address goes out as a photo with the notice as caption', async () => {
  answerWith(() => telegramSays(true, { ok: true, result: { message_id: 9 } }))
  const { plugins, bus } = await install()
  await plugins.saveSettings('telegram', { botToken: TOKEN, chatId: CHAT })
  await bus.notify('📊 Reel: its first 24 hours', undefined, { photoUrl: 'https://cdn.example/cover.jpg' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendPhoto`)
  assert.equal(calls[0]?.body['photo'], 'https://cdn.example/cover.jpg')
  assert.equal(calls[0]?.body['caption'], '📊 Reel: its first 24 hours')
  plugins.dispose()
})

test('a notice longer than a caption: the picture with the first lines, then the rest', async () => {
  answerWith(() => telegramSays(true, { ok: true, result: { message_id: 10 } }))
  const { plugins, bus } = await install()
  await plugins.saveSettings('telegram', { botToken: TOKEN, chatId: CHAT })
  const long = Array.from({ length: 60 }, (_, i) => `line ${String(i)} ${'x'.repeat(20)}`).join('\n')
  await bus.notify(long, undefined, { photoUrl: 'https://cdn.example/p.jpg' })
  assert.equal(calls.length, 2)
  assert.match(calls[0]?.url ?? '', /sendPhoto$/)
  assert.match(calls[1]?.url ?? '', /sendMessage$/)
  const caption = String(calls[0]?.body['caption'])
  const rest = String(calls[1]?.body['text'])
  assert.ok(caption.length <= 1024)
  assert.equal(`${caption}\n${rest}`, long, 'nothing is lost between the two')
  plugins.dispose()
})

test('a picture Telegram refuses falls back to the text alone', async () => {
  answerWith(body => body['photo'] !== undefined
    ? telegramSays(false, { ok: false, description: 'Bad Request: wrong file identifier/HTTP URL specified' })
    : telegramSays(true, { ok: true, result: { message_id: 11 } }))
  const { plugins, bus } = await install()
  await plugins.saveSettings('telegram', { botToken: TOKEN, chatId: CHAT })
  await bus.notify('✅ Reel published', undefined, { photoUrl: 'https://cdn.example/gone.jpg' })
  assert.equal(calls.length, 2)
  assert.match(calls[1]?.url ?? '', /sendMessage$/)
  assert.equal(calls[1]?.body['text'], '✅ Reel published')
  plugins.dispose()
})

test('a local picture is uploaded as a file', async () => {
  const uploads: { url: string; form: FormData }[] = []
  globalThis.fetch = (async (input: string | URL, init?: { body?: unknown }) => {
    if (init?.body instanceof FormData) uploads.push({ url: String(input), form: init.body })
    return telegramSays(true, { ok: true, result: { message_id: 12 } })
  }) as unknown as typeof fetch
  const { plugins, bus, dir } = await install()
  await plugins.saveSettings('telegram', { botToken: TOKEN, chatId: CHAT })
  const picture = join(dir, 'p.jpg')
  await writeFile(picture, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  await bus.notify('✅ Post published', undefined, { photoPath: picture })
  assert.equal(uploads.length, 1)
  assert.match(uploads[0]?.url ?? '', /sendPhoto$/)
  assert.equal(uploads[0]?.form.get('chat_id'), CHAT)
  assert.equal(uploads[0]?.form.get('caption'), '✅ Post published')
  const file = uploads[0]?.form.get('photo') as Blob
  assert.equal(file.size, 4)
  plugins.dispose()
})
