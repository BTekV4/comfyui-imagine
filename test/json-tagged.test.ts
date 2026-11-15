/**
 * `writeJsonTagged`: the same body answers 304 to a client that sends its tag
 * back, a changed body a new tag and the whole answer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeJsonTagged } from '../server/src/route-kit.ts'

test('an unchanged answer is a 304, a changed one a new tag', async () => {
  let body = JSON.stringify({ ok: true, posts: [{ id: 'a' }] })
  const server = createServer((req, res) => { writeJsonTagged('test-posts', req, res, req.method, body) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
  try {
    const first = await fetch(url)
    const tag = first.headers.get('etag')
    assert.equal(first.status, 200)
    assert.ok(tag !== null)
    assert.deepEqual(await first.json(), { ok: true, posts: [{ id: 'a' }] })

    const same = await fetch(url, { headers: { 'if-none-match': tag } })
    assert.equal(same.status, 304)
    assert.equal(await same.text(), '')

    body = JSON.stringify({ ok: true, posts: [{ id: 'a' }, { id: 'b' }] })
    const changed = await fetch(url, { headers: { 'if-none-match': tag } })
    assert.equal(changed.status, 200)
    assert.notEqual(changed.headers.get('etag'), tag)
  } finally {
    server.close()
  }
})
