/**
 * The Meta token, as seen from Settings: read masked, and written without
 * losing what the OAuth flow put in the file.
 *
 * The `api_token.json` file is not ours: the dashboard that runs the OAuth
 * writes it, and next to the token keeps ids, permissions, account type and
 * notes. A save that rewrote the whole file would delete those keys, and
 * publishing would stop working without an error saying so.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tokenDir } from './helpers/token-files.ts'

const { readTokenState, saveAccessToken, checkAccessToken, EXPIRING_SOON_DAYS } = await import('../plugins/instagram/src/token.ts')

const root = await mkdtemp(join(tmpdir(), 'imagine-token-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

/** The real prefix, assembled: not even the tests contain the head of a token. */
const PREFIX = 'IG' + 'AA'

/** A token of the real shape: that prefix and 159 characters. */
const TOKEN = `${PREFIX}${'x9'.repeat(77)}A`

/** The shape of the live file, with the fields the OAuth flow puts in it. */
function liveShape(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'instagram_login_with_comment_management',
    api_base: 'https://graph.instagram.com',
    access_token: TOKEN,
    expires_in: 5183999,
    obtained: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    ig_app_id: '1000000000000001',
    ig_user_id: '17840000000001789',
    username: 'un-account',
    account_type: 'MEDIA_CREATOR',
    permissions: ['instagram_business_basic'],
    refresh: { method: 'instagram_login', note: 'long-lived token' },
    source: 'test',
    ...overrides,
  }
}

/** A config folder with the token file already written. */
async function dirWith(config: Record<string, unknown>): Promise<string> {
  return tokenDir(root, 'api_token.json', config)
}

test('the state is masked: no token, but account, id tail and days', async () => {
  const dir = await dirWith(liveShape())
  const state = await readTokenState(dir)
  assert.equal(state.hasToken, true)
  assert.equal(state.username, 'un-account')
  assert.equal(state.accountType, 'MEDIA_CREATOR')
  assert.equal(state.igUserIdTail, '1789')
  assert.ok(state.expiresInDays !== null && state.expiresInDays > 50, `days: ${String(state.expiresInDays)}`)
  assert.equal(state.expired, false)
  assert.equal(state.expiringSoon, false)
  assert.equal(JSON.stringify(state).includes(TOKEN), false, 'the token must not appear in the state')
})

test('a token expiring in a few days is flagged, and an expired one is expired', async () => {
  const soon = await readTokenState(await dirWith(liveShape({
    obtained: new Date(Date.now() - 55 * 24 * 60 * 60 * 1000).toISOString(),
    expires_in: 60 * 24 * 60 * 60,
  })))
  assert.ok(soon.expiresInDays !== null && soon.expiresInDays <= EXPIRING_SOON_DAYS)
  assert.equal(soon.expiringSoon, true)
  assert.equal(soon.expired, false)
  const gone = await readTokenState(await dirWith(liveShape({
    obtained: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    expires_in: 60 * 24 * 60 * 60,
  })))
  assert.equal(gone.expired, true)
  assert.ok(gone.expiresInDays !== null && gone.expiresInDays < 0)
})

test('without a file the state says there is no token', async () => {
  const dir = await mkdtemp(join(root, 'empty-'))
  const state = await readTokenState(dir)
  assert.equal(state.hasToken, false)
  assert.equal(state.username, null)
  assert.equal(state.expiresInDays, null)
})

test('saving the token keeps the other keys, and leaves a backup', async () => {
  const dir = await dirWith(liveShape())
  const before = await readFile(join(dir, 'api_token.json'), 'utf8')
  const next = `${PREFIX}${'z7'.repeat(70)}Q`
  const result = await saveAccessToken({ accessToken: next }, dir)
  assert.equal(result.state.hasToken, true)
  assert.ok(result.backup !== null)
  assert.equal(await readFile(result.backup, 'utf8'), before, 'the backup is the previous file')
  const stored = JSON.parse(await readFile(join(dir, 'api_token.json'), 'utf8')) as Record<string, unknown>
  assert.equal(stored['access_token'], next)
  // Everything else is what was there.
  for (const key of ['type', 'api_base', 'ig_app_id', 'ig_user_id', 'username', 'account_type', 'permissions', 'refresh', 'source']) {
    assert.deepEqual(stored[key], liveShape()[key], `key lost: ${key}`)
  }
  // `obtained` is now, `expires_in` stays the file's.
  assert.ok(Date.parse(String(stored['obtained'])) > Date.now() - 60_000)
  assert.equal(stored['expires_in'], 5183999)
  const files = await readdir(dir)
  assert.equal(files.filter(name => name.startsWith('api_token.json.bak-')).length, 1)
})

test('duration and username are written only when given', async () => {
  const dir = await dirWith(liveShape())
  const kept = await saveAccessToken({ accessToken: TOKEN, expiresIn: 3600 }, dir)
  assert.equal(kept.state.username, 'un-account')
  const stored = JSON.parse(await readFile(join(dir, 'api_token.json'), 'utf8')) as Record<string, unknown>
  assert.equal(stored['expires_in'], 3600)
  await saveAccessToken({ accessToken: TOKEN, username: 'other-account' }, dir)
  const after = await readTokenState(dir)
  assert.equal(after.username, 'other-account')
})

test('saving the same token again does not move the expiry and leaves the file as it was', async () => {
  const dir = await dirWith(liveShape())
  const beforeFile = await readFile(join(dir, 'api_token.json'), 'utf8')
  const beforeState = await readTokenState(dir)
  const result = await saveAccessToken({ accessToken: TOKEN }, dir)
  // No `expiresIn`: the file does not change by a byte, and `obtained` does not move.
  assert.equal(await readFile(join(dir, 'api_token.json'), 'utf8'), beforeFile)
  assert.equal(result.state.obtained, beforeState.obtained)
  assert.equal(result.state.expiresAt, beforeState.expiresAt)
  // With a declared duration, instead, the stamp is new.
  await saveAccessToken({ accessToken: TOKEN, expiresIn: 3600 }, dir)
  const afterStamp = await readTokenState(dir)
  assert.notEqual(afterStamp.obtained, beforeState.obtained)
})

test('an invalid token is refused and the file is not touched', async () => {
  const dir = await dirWith(liveShape())
  const before = await readFile(join(dir, 'api_token.json'), 'utf8')
  for (const bad of ['', '   ', 'EAAB1234567890', `${PREFIX}123`, `${PREFIX}${'x'.repeat(30)}\n${'y'.repeat(30)}`, `${PREFIX}${'x'.repeat(60)} 123`]) {
    await assert.rejects(saveAccessToken({ accessToken: bad }, dir), Error, JSON.stringify(bad.slice(0, 20)))
  }
  assert.equal(await readFile(join(dir, 'api_token.json'), 'utf8'), before)
  assert.equal((await readdir(dir)).filter(name => name.startsWith('api_token.json.bak-')).length, 0)
})

test('an out-of-range duration and a username with spaces are refused', async () => {
  const dir = await dirWith(liveShape())
  await assert.rejects(saveAccessToken({ accessToken: TOKEN, expiresIn: 0 }, dir), /durata/)
  await assert.rejects(saveAccessToken({ accessToken: TOKEN, expiresIn: -5 }, dir), /durata/)
  await assert.rejects(saveAccessToken({ accessToken: TOKEN, expiresIn: 2 * 366 * 24 * 3600 }, dir), /durata/)
  await assert.rejects(saveAccessToken({ accessToken: TOKEN, username: 'two words' }, dir), /nome utente/)
})

test('the shape check alone writes nothing', () => {
  // Surrounding spaces (a paste often brings them) are trimmed; inner ones are not.
  assert.equal(checkAccessToken(`  ${TOKEN}  `), TOKEN)
  assert.equal(checkAccessToken(`${TOKEN}\n`), TOKEN)
  assert.throws(() => checkAccessToken(PREFIX), /lunghezza/)
  assert.throws(() => checkAccessToken("EAABy"), /cominciare con IG/)
})
