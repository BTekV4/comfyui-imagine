/**
 * Page addresses: a link must open the page it names, even if it was written
 * when the paths were in Italian.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageOf, pathOf } from '../web/vendor-imagine/client/imagine-routes.ts'

test('every page has its address, and it round-trips', () => {
  assert.equal(pathOf('home', undefined), '/')
  assert.equal(pathOf('media', undefined), '/media')
  assert.equal(pathOf('settings', undefined), '/settings')
  assert.deepEqual(pageOf('/media'), { view: 'media' })
  assert.deepEqual(pageOf('/settings'), { view: 'settings' })
})

test('the old Italian paths still open the right page', () => {
  assert.deepEqual(pageOf('/impostazioni'), { view: 'settings' })
  assert.deepEqual(pageOf('/libreria'), { view: 'library' })
  assert.deepEqual(pageOf('/tutti-i-media'), { view: 'media' })
})

test('a project carries its id, and a malformed one does not pass', () => {
  const path = pathOf('project', 'abc def')
  assert.equal(path, '/project/abc%20def')
  assert.deepEqual(pageOf(path), { view: 'project', projectId: 'abc def' })
  assert.equal(pageOf('/project/a/b'), undefined)
  assert.equal(pageOf('/niente'), undefined)
})

test('a trailing slash does not change the page', () => {
  assert.deepEqual(pageOf('/settings/'), { view: 'settings' })
})
