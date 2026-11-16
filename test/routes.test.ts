/**
 * Page addresses: a link must open the page it names, even if it was written
 * when the paths were in Italian.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPanelPath, pageOf, pathOf, samePanel } from '../web/vendor-imagine/client/imagine-routes.ts'

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

test('every card of the home grid has its own address, and it round-trips', () => {
  assert.equal(pathOf('home', undefined, { kind: 'tool', id: 'video' }), '/tool/video')
  assert.deepEqual(pageOf('/tool/video'), { view: 'home', panel: { kind: 'tool', id: 'video' } })
  assert.equal(pathOf('home', undefined, { kind: 'model', id: 'photo-edit' }), '/model/photo-edit')
  assert.deepEqual(pageOf('/model/photo-edit/'), { view: 'home', panel: { kind: 'model', id: 'photo-edit' } })
  assert.equal(pathOf('home', undefined, { kind: 'workflow', id: 'my look' }), '/workflow/my%20look')
  assert.deepEqual(pageOf('/workflow/my%20look'), { view: 'home', panel: { kind: 'workflow', id: 'my look' } })
  // A panel belongs to the home: another page ignores it.
  assert.equal(pathOf('media', undefined, { kind: 'tool', id: 'video' }), '/media')
})

test('an unknown or malformed card opens the bare home', () => {
  assert.deepEqual(pageOf('/tool/nothing'), { view: 'home' })
  assert.deepEqual(pageOf('/tool/constructor'), { view: 'home' })
  assert.deepEqual(pageOf('/model/nope'), { view: 'home' })
  assert.deepEqual(pageOf('/tool/a/b'), { view: 'home' })
  assert.deepEqual(pageOf('/workflow/%E0%A4%A'), { view: 'home' })
  // `/tool/` is `/tool` once tidied: no page, so the studio opens the home as for any unknown path.
  assert.equal(pageOf('/tool/'), undefined)
  assert.ok(isPanelPath('/tool/nothing'))
  assert.ok(!isPanelPath('/project/x'))
})

test('panels compare by kind and id', () => {
  assert.ok(samePanel(undefined, undefined))
  assert.ok(samePanel({ kind: 'model', id: 'ugc' }, { kind: 'model', id: 'ugc' }))
  assert.ok(!samePanel({ kind: 'model', id: 'ugc' }, { kind: 'workflow', id: 'ugc' }))
  assert.ok(!samePanel({ kind: 'tool', id: 'video' }, undefined))
})
