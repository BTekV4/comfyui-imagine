/**
 * The two Instagram comment tokens, as seen from Settings.
 *
 * `facebook_comments_token.json` is not ours: a Facebook Login exchange writes
 * it, and next to the two tokens keeps the page and user ids, the permissions,
 * the source and a note. The comment manager answers with the **page** token
 * and falls back to the **user** one: they are written one at a time, without
 * throwing away the other or the exchange's keys.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { readFacebookTokenState, saveFacebookTokens, checkFacebookToken } = await import('../plugins/instagram/src/token.ts')

const root = await mkdtemp(join(tmpdir(), 'imagine-fbtoken-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

/** The real prefix, assembled: not even the tests contain the head of a token. */
const PREFIX = 'E' + 'AA'

const PAGE = `${PREFIX}P${'p9'.repeat(60)}`
const USER = `${PREFIX}U${'u7'.repeat(55)}`

/** The shape of the live file, with the exchange's keys. */
function liveShape(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'facebook_user_and_page_for_ig_comments',
    api_base: 'https://graph.facebook.com',
    obtained: '2026-08-22T06:17:15.235825+00:00',
    source: 'fb-exchange-token-60d-2026-08-22',
    fb_user_id: '100000000000005939',
    fb_app_id: '1000000000000002',
    page_id: '1000000000004889',
    page_name: 'Example Page',
    ig_user_id: '17840000000001789',
    ig_username: 'example_account',
    user_access_token: USER,
    page_access_token: PAGE,
    permissions: ['pages_show_list', 'instagram_manage_comments'],
    user_token_expires_at: Math.floor((Date.now() - 16 * 24 * 60 * 60 * 1000) / 1000),
    note: 'long-lived user token after app-secret reveal + fb_exchange_token',
    ...overrides,
  }
}

async function dirWith(config: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(root, 'cfg-'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'facebook_comments_token.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return dir
}

test('the state is masked: no token, but page, account and days', async () => {
  const dir = await dirWith(liveShape())
  const state = await readFacebookTokenState(dir)
  assert.equal(state.hasToken, true)
  assert.equal(state.hasPageToken, true)
  assert.equal(state.hasUserToken, true)
  assert.equal(state.pageName, 'Example Page')
  assert.equal(state.igUsername, 'example_account')
  assert.equal(state.pageIdTail, '4889')
  assert.equal(state.fbUserIdTail, '5939')
  assert.ok(state.expiresInDays !== null && state.expiresInDays < 0, `days: ${String(state.expiresInDays)}`)
  assert.equal(state.expired, true)
  const json = JSON.stringify(state)
  assert.equal(json.includes(PAGE), false, 'the page token must not appear')
  assert.equal(json.includes(USER), false, 'the user token must not appear')
})

test('without a file the state says there are no tokens, without errors', async () => {
  const dir = await mkdtemp(join(root, 'empty-'))
  const state = await readFacebookTokenState(dir)
  assert.equal(state.hasToken, false)
  assert.equal(state.hasPageToken, false)
  assert.equal(state.hasUserToken, false)
  assert.equal(state.expiresInDays, null)
  assert.equal(state.expired, false)
})

test('a missing expiry is unknown, not expired; a close one is flagged', async () => {
  const unknown = await readFacebookTokenState(await dirWith(liveShape({ user_token_expires_at: undefined })))
  assert.equal(unknown.expiresInDays, null)
  assert.equal(unknown.expired, false)
  const soon = await readFacebookTokenState(await dirWith(liveShape({
    user_token_expires_at: Math.floor((Date.now() + 3 * 24 * 60 * 60 * 1000) / 1000),
  })))
  assert.equal(soon.expiringSoon, true)
  assert.equal(soon.expired, false)
})

test('saving keeps the exchange keys and leaves a backup of the previous file', async () => {
  const dir = await dirWith(liveShape())
  const before = await readFile(join(dir, 'facebook_comments_token.json'), 'utf8')
  const newPage = `${PREFIX}N${'n5'.repeat(60)}`
  const result = await saveFacebookTokens({ pageAccessToken: newPage }, dir)
  assert.ok(result.backup !== null)
  assert.equal(await readFile(result.backup, 'utf8'), before)
  const stored = JSON.parse(await readFile(join(dir, 'facebook_comments_token.json'), 'utf8')) as Record<string, unknown>
  assert.equal(stored['page_access_token'], newPage)
  assert.equal(stored['user_access_token'], USER, 'the user token is not touched')
  for (const key of ['type', 'api_base', 'source', 'fb_user_id', 'fb_app_id', 'page_id', 'page_name', 'ig_user_id', 'ig_username', 'permissions', 'note']) {
    assert.deepEqual(stored[key], liveShape()[key], `key lost: ${key}`)
  }
  assert.equal((await readdir(dir)).filter(name => name.startsWith('facebook_comments_token.json.bak-')).length, 1)
})

test('saving only the user token does not touch the page token', async () => {
  const dir = await dirWith(liveShape())
  const newUser = `${PREFIX}V${'v3'.repeat(55)}`
  await saveFacebookTokens({ userAccessToken: newUser }, dir)
  const stored = JSON.parse(await readFile(join(dir, 'facebook_comments_token.json'), 'utf8')) as Record<string, unknown>
  assert.equal(stored['user_access_token'], newUser)
  assert.equal(stored['page_access_token'], PAGE)
})

test('a new user token does not inherit the old expiry, and a declared duration writes it', async () => {
  const dir = await dirWith(liveShape())
  await saveFacebookTokens({ userAccessToken: `${PREFIX}W${'w2'.repeat(55)}` }, dir)
  const cleared = JSON.parse(await readFile(join(dir, 'facebook_comments_token.json'), 'utf8')) as Record<string, unknown>
  assert.equal('user_token_expires_at' in cleared, false, 'the old expiry belonged to the old token')
  assert.equal((await readFacebookTokenState(dir)).expiresInDays, null)
  // With a declared duration, instead, the file records it.
  await saveFacebookTokens({ userAccessToken: `${PREFIX}X${'x4'.repeat(55)}`, expiresIn: 3600 }, dir)
  const stated = await readFacebookTokenState(dir)
  assert.ok(stated.expiresInDays !== null && stated.expiresInDays >= 0 && stated.expiresInDays <= 1, `days: ${String(stated.expiresInDays)}`)
})

test('saving the same two tokens again leaves the file byte for byte as it was', async () => {
  const dir = await dirWith(liveShape())
  const before = await readFile(join(dir, 'facebook_comments_token.json'), 'utf8')
  const result = await saveFacebookTokens({ pageAccessToken: PAGE, userAccessToken: USER }, dir)
  assert.equal(result.backup !== null, true, 'the backup is made anyway')
  assert.equal(await readFile(join(dir, 'facebook_comments_token.json'), 'utf8'), before)
})

test('an invalid token is refused and the file is not touched', async () => {
  const dir = await dirWith(liveShape())
  const before = await readFile(join(dir, 'facebook_comments_token.json'), 'utf8')
  for (const bad of ['', '   ', 'IG' + 'AA' + 'x'.repeat(120), `${PREFIX}${'x'.repeat(30)}\n${'y'.repeat(30)}`, 'EAABy']) {
    await assert.rejects(saveFacebookTokens({ pageAccessToken: bad }, dir), Error, JSON.stringify(bad.slice(0, 16)))
  }
  await assert.rejects(saveFacebookTokens({}, dir), /almeno uno/)
  assert.equal(await readFile(join(dir, 'facebook_comments_token.json'), 'utf8'), before)
  assert.equal((await readdir(dir)).filter(name => name.startsWith('facebook_comments_token.json.bak-')).length, 0)
})

test('without a file the save creates it with the right shape', async () => {
  const dir = await mkdtemp(join(root, 'new-'))
  const result = await saveFacebookTokens({ pageAccessToken: PAGE }, dir)
  assert.equal(result.backup, null)
  const stored = JSON.parse(await readFile(join(dir, 'facebook_comments_token.json'), 'utf8')) as Record<string, unknown>
  assert.equal(stored['type'], 'facebook_user_and_page_for_ig_comments')
  assert.equal(stored['api_base'], 'https://graph.facebook.com')
  assert.equal(stored['page_access_token'], PAGE)
  assert.equal(result.state.hasPageToken, true)
  assert.equal(result.state.hasUserToken, false)
})

test('the shape check alone writes nothing', () => {
  assert.equal(checkFacebookToken(`  ${PAGE}  `), PAGE)
  assert.throws(() => checkFacebookToken('EAABy'), /lunghezza/)
  assert.throws(() => checkFacebookToken('IG' + 'AA' + 'x'.repeat(120)), /cominciare con/)
})
