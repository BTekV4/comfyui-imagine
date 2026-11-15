/**
 * "Check with Meta": the page asks Meta whether the two comment tokens work,
 * instead of trusting the date written in the file.
 *
 * On 2026-11-06 the file said the user token had expired on October 21 while
 * Meta answered `is_valid: true` and `expires_at: 0` for both: a red line on
 * something that works is the worst thing to show whoever is configuring it.
 * The call is on demand, has a short timeout and writes nothing.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeFetch } from './helpers/fake-fetch.ts'
import { tokenDir } from './helpers/token-files.ts'

const { checkFacebookTokens, CHECK_TIMEOUT_MS } = await import('../plugins/instagram/src/token-check.ts')

const root = await mkdtemp(join(tmpdir(), 'imagine-fbcheck-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

const PREFIX = 'E' + 'AA'
const PAGE = `${PREFIX}P${'p9'.repeat(60)}`
const USER = `${PREFIX}U${'u7'.repeat(55)}`

/** Fake calls, so the tests never reach Meta. */
const network = fakeFetch(input => new URL(String(input)))
const { calls } = network

function answerWith(byToken: (token: string) => unknown): void {
  network.answerWith(url => ({ status: 200, json: async () => byToken(url.searchParams.get('input_token') ?? '') }))
}

/** A valid debug_token, in the shape Meta returns. */
function debugInfo(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      app_id: '1000000000000002',
      type: 'PAGE',
      application: 'Example App',
      data_access_expires_at: 1800247823,
      expires_at: 0,
      is_valid: true,
      issued_at: 1755845833,
      scopes: ['pages_show_list', 'business_management', 'instagram_basic', 'instagram_manage_comments', 'pages_read_engagement', 'instagram_business_manage_comments', 'pages_manage_metadata'],
      ...overrides,
    },
  }
}

async function dirWith(tokens: Record<string, string>): Promise<string> {
  return tokenDir(root, 'facebook_comments_token.json', {
    type: 'facebook_user_and_page_for_ig_comments',
    api_base: 'https://graph.facebook.com',
    obtained: '2026-08-22T06:17:15.235825+00:00',
    page_id: '1000000000004889',
    page_name: 'Example Page',
    ig_username: 'example_account',
    user_token_expires_at: 1792563431,
    ...tokens,
  })
}

test('two valid tokens: expires_at 0 becomes null, the data-access expiry stays a date, verdict valid', async () => {
  answerWith((token) => debugInfo({ type: token === PAGE ? 'PAGE' : 'USER' }))
  const check = await checkFacebookTokens(await dirWith({ page_access_token: PAGE, user_access_token: USER }))
  assert.equal(check.checked, true)
  assert.equal(check.verdict, 'valid')
  assert.equal(check.page?.valid, true)
  assert.equal(check.page?.type, 'PAGE')
  assert.equal(check.page?.expiresAt, null, 'expires_at 0 = no expiry, not 1970')
  assert.equal(check.page?.dataAccessExpiresAt, new Date(1800247823 * 1000).toISOString())
  assert.equal(check.page?.scopes, 7)
  assert.equal(check.user?.type, 'USER')
  // The page token is asked about first.
  assert.equal(calls[0]?.searchParams.get('input_token'), PAGE)
  assert.equal(calls.length, 2)
  assert.match(calls[0]?.pathname ?? '', /\/v25\.0\/debug_token$/)
  assert.equal(calls[0]?.searchParams.get('access_token'), PAGE)
})

test('the answer does not contain the tokens', async () => {
  answerWith(() => debugInfo())
  const check = await checkFacebookTokens(await dirWith({ page_access_token: PAGE, user_access_token: USER }))
  const json = JSON.stringify(check)
  assert.equal(json.includes(PAGE), false)
  assert.equal(json.includes(USER), false)
})

test('a token Meta rejects: verdict invalid, with Meta\'s reason', async () => {
  answerWith((token) => token === PAGE
    ? { data: { is_valid: false, type: 'PAGE', expires_at: 0 }, error: { message: 'Error validating access token: Session has expired' } }
    : debugInfo({ type: 'USER' }))
  const check = await checkFacebookTokens(await dirWith({ page_access_token: PAGE, user_access_token: USER }))
  assert.equal(check.verdict, 'invalid')
  assert.equal(check.page?.valid, false)
  assert.match(check.page?.error ?? '', /Session has expired/)
  assert.equal(check.user?.valid, true, 'the other token is still checked')
})

test('Meta unreachable: verdict unknown, no exception, the reason in the error field', async () => {
  globalThis.fetch = (async () => { throw new Error('getaddrinfo ENOTFOUND graph.facebook.com') }) as unknown as typeof fetch
  const check = await checkFacebookTokens(await dirWith({ page_access_token: PAGE, user_access_token: USER }))
  assert.equal(check.verdict, 'unknown')
  assert.equal(check.page?.valid, null)
  assert.equal(check.user?.valid, null)
  assert.match(check.page?.error ?? '', /non raggiungibile|unreachable/)
})

test('Meta not answering within the timeout: unknown with the reason, not an error', async () => {
  globalThis.fetch = (async () => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  }) as unknown as typeof fetch
  const check = await checkFacebookTokens(await dirWith({ page_access_token: PAGE }), 50)
  assert.equal(check.verdict, 'unknown')
  assert.match(check.page?.error ?? '', /non ha risposto|did not answer/)
  assert.ok(CHECK_TIMEOUT_MS >= 1000, 'the page\'s real timeout is not a fraction of a second')
})

test('no token means nothing to ask: checked false, no call', async () => {
  answerWith(() => debugInfo())
  const check = await checkFacebookTokens(await dirWith({}))
  assert.equal(check.checked, false)
  assert.equal(check.verdict, 'unknown')
  assert.match(check.error ?? '', /nessun token|no token/)
  assert.equal(calls.length, 0)
})

test('an answer without `data` is not a valid token: unknown, with HTTP in the reason', async () => {
  answerWith(() => ({ error: { message: 'Invalid OAuth access token.' } }))
  const check = await checkFacebookTokens(await dirWith({ page_access_token: PAGE }))
  assert.equal(check.verdict, 'unknown')
  assert.match(check.page?.error ?? '', /Invalid OAuth access token/)
})

test('Meta\'s reason never leaks the token, even when it quotes it', async () => {
  answerWith((token) => ({ data: { is_valid: false, type: 'PAGE' }, error: { message: `Invalid token ${token}` } }))
  const check = await checkFacebookTokens(await dirWith({ page_access_token: PAGE }))
  const json = JSON.stringify(check)
  assert.equal(json.includes(PAGE), false, 'the token must be scrubbed from the reason')
  assert.match(check.page?.error ?? '', /\[token\]/)
})

test('the check writes nothing to disk', async () => {
  answerWith(() => debugInfo())
  const dir = await dirWith({ page_access_token: PAGE, user_access_token: USER })
  const file = join(dir, 'facebook_comments_token.json')
  const before = createHash('md5').update(await readFile(file)).digest('hex')
  const listing = (await readdir(dir)).sort()
  await checkFacebookTokens(dir)
  const after = createHash('md5').update(await readFile(file)).digest('hex')
  assert.equal(after, before)
  assert.deepEqual((await readdir(dir)).sort(), listing, 'no new file: no copies, no cache')
})
