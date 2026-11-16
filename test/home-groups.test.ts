/**
 * The home's one grid: every flow card and every model has one filter group,
 * every group has cards, and «All» opens with the studio's own tools.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TEMPLATES } from '../shared/imagine-templates.ts'
import { JOB_CARDS } from '../web/vendor-imagine/client/job-cards.ts'
import {
  FILTER_LABEL, FLOW_GROUP, HOME_GROUPS, MODEL_GROUP, filterHome, homeOrder, isHomeFilter,
} from '../web/vendor-imagine/client/home-groups.ts'

test('every flow card and every model has a group, and nothing else does', () => {
  for (const card of JOB_CARDS) assert.ok(HOME_GROUPS.includes(FLOW_GROUP[card.id]), card.id)
  for (const template of TEMPLATES) assert.ok(HOME_GROUPS.includes(MODEL_GROUP[template.id]), template.id)
  assert.deepEqual(Object.keys(FLOW_GROUP).sort(), JOB_CARDS.map(card => card.id).sort())
  assert.deepEqual(Object.keys(MODEL_GROUP).sort(), TEMPLATES.map(template => template.id).sort())
})

test('every group has at least one card, and every chip has its words', () => {
  const all = homeOrder()
  for (const group of HOME_GROUPS) assert.ok(filterHome(all, group).length > 0, group)
  for (const chip of ['all', ...HOME_GROUPS] as const) assert.ok(FILTER_LABEL[chip].startsWith('imagine.home.group.'))
})

test('«All» holds each card once, opens with the core flows and mixes the models in', () => {
  const all = homeOrder()
  assert.equal(all.length, JOB_CARDS.length + TEMPLATES.length)
  assert.equal(new Set(all.map(entry => `${entry.kind}:${entry.id}`)).size, all.length)
  assert.deepEqual(all.slice(0, 4).map(entry => entry.id), ['generate', 'remix', 'style', 'video'])
  // The first screen (two rows of three after the core four) is not only models.
  const firstScreen = all.slice(0, 12)
  assert.ok(firstScreen.some(entry => entry.kind === 'model'))
  assert.ok(firstScreen.filter(entry => entry.kind === 'flow').length >= 6)
  // Deterministic.
  assert.deepEqual(homeOrder(), all)
})

test('a chip keeps the order of «All»', () => {
  const all = homeOrder()
  const video = filterHome(all, 'video')
  assert.deepEqual(video, all.filter(entry => entry.group === 'video'))
  assert.deepEqual(filterHome(all, 'all'), all)
})

test('uploaded workflows go last, grouped by what they make', () => {
  const all = homeOrder([{ id: 'a', output: 'image' }, { id: 'b', output: 'video' }])
  assert.deepEqual(all.slice(-2), [
    { kind: 'custom', id: 'a', group: 'photo' },
    { kind: 'custom', id: 'b', group: 'video' },
  ])
})

test('only a chip is a stored filter', () => {
  assert.ok(isHomeFilter('all'))
  assert.ok(isHomeFilter('graphics'))
  assert.ok(!isHomeFilter('models'))
  assert.ok(!isHomeFilter(null))
})
