/**
 * The swaps' resolution travels as a label (2026-11-15): the composer's step
 * maps onto the swap ladder, and the ladder onto the label Openjutsu's plan
 * takes — 720p leaves the graph's own 736p.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SWAP_PLAN_RESOLUTION, SWAP_RESOLUTIONS, swapResolutionOf } from '../shared/imagine-sizing.ts'

test('every composer step lands on the swap ladder', () => {
  assert.equal(swapResolutionOf('480p'), '480p')
  assert.equal(swapResolutionOf('720p'), '720p')
  assert.equal(swapResolutionOf('1080p'), '1080p')
  assert.equal(swapResolutionOf('1440p'), '1080p')
})

test('the plan label of each step, 720p keeping the graph default', () => {
  assert.deepEqual(SWAP_RESOLUTIONS.map(step => SWAP_PLAN_RESOLUTION[step]), ['480p', undefined, '1080p'])
})
