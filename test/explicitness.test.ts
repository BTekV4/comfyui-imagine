/**
 * The few words that keep a run from going further than the line asked.
 *
 * Measured on 2026-11-21: "more sensual" became nudity nobody asked for, and
 * the reply then denied it. The guard reads the words, not the intent: it
 * allows what the user wrote and refuses what only the run added.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deniesExplicitness, escalatedLabels, explicitLabels } from '../server/vendor/tool-comfy/explicitness.ts'

test('a run cannot add nudity or explicit content the line did not ask for', () => {
  assert.deepEqual(explicitLabels('una donna in un campo, sensuale'), [])
  assert.deepEqual(explicitLabels('una donna nuda in un campo'), ['nudity'])
  assert.deepEqual(escalatedLabels('una donna nuda in un campo', 'una donna in un campo, sensuale'), ['nudity'])
  // What the user wrote is permission: the same words are not an escalation.
  assert.deepEqual(escalatedLabels('una donna nuda in un campo', 'una donna nuda in un campo'), [])
  assert.deepEqual(escalatedLabels('a topless portrait', 'a portrait'), ['nudity'])
  assert.deepEqual(escalatedLabels('contenuto esplicito', 'una foto di coppia'), ['explicitness'])
  // A seno that is not uncovered is not nudity.
  assert.deepEqual(explicitLabels('seno coperto da un vestito'), [])
})

test('a denial of what the vision pass reported is not an acknowledgement', () => {
  assert.equal(deniesExplicitness('Non l\'ho fatta nuda: la donna è vestita.'), true)
  assert.equal(deniesExplicitness('I did not make her nude, she is dressed.'), true)
  // A plain description is what the reply has to carry, and it is not a denial.
  assert.equal(deniesExplicitness('Il risultato è nudo, non richiesto: mi dispiace.'), false)
  assert.equal(deniesExplicitness('La foto è pronta.'), false)
})
