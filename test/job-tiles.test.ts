/**
 * Which live jobs get a tile of their own on the board.
 *
 * A story's preparation job holds the queue's place while the track's voice is
 * measured and has no file to draw: drawn anyway it was an empty frame for the
 * length of the measurement (measured 2026-11-17).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimsTile } from '../web/vendor-imagine/client/job-tiles.ts'

const file = { name: 'videoclip-abc-01of02.mp4', kind: 'video' as const }

test('the preparation job draws no tile until it has something to show', () => {
  assert.equal(claimsTile({ action: 'story', status: 'running', files: [] }), false)
  assert.equal(claimsTile({ action: 'story', status: 'running' }), false)
  // The shots it queues do: that is where the work shows.
  assert.equal(claimsTile({ action: 'video', status: 'running' }), true)
  // A story job that has landed a file is a result like any other.
  assert.equal(claimsTile({ action: 'story', status: 'done', files: [file] }), true)
  // A failure keeps its tile: the tile is where the reason is said.
  assert.equal(claimsTile({ action: 'story', status: 'error' }), true)
})
