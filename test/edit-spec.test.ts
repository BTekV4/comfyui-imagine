/**
 * The spec every run is built from: what changes, what stays, and the faults
 * the code refuses before the run is queued.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { explicitnessRefusal, specFor, specRefusals } from '../server/vendor/tool-comfy/edit-spec.ts'

test('an edit keeps everything the line does not name, and a generation keeps nothing', () => {
  const kept = specFor('cambia il colore della tazza', { edit: true })
  assert.deepEqual(kept.preserve, ['framing', 'text', 'subjects', 'style', 'format'])
  assert.equal(kept.intensity, 'as-asked')
  // A shape the line names is a shape the run may change.
  assert.deepEqual(specFor('falla 9:16', { edit: true }).preserve, ['framing', 'text', 'subjects', 'style'])
  assert.deepEqual(specFor('cambia le scritte sul muro', { edit: true }).preserve, ['framing', 'subjects', 'style', 'format'])
  assert.deepEqual(specFor('avvicina, primo piano', { edit: true }).preserve, ['text', 'subjects', 'style', 'format'])
  assert.deepEqual(specFor('in stile poster', { edit: true }).preserve, ['framing', 'text', 'subjects', 'format'])
  // "più X" is one step from the last accepted result, never a new picture.
  assert.equal(specFor('rendila più luminosa', { edit: true }).intensity, 'one-step')
  assert.equal(specFor('make it more colourful', { edit: true }).intensity, 'one-step')
  // A generation has no source: there is nothing to preserve.
  assert.deepEqual(specFor('un faro al tramonto', { edit: false }).preserve, [])
})

test('a run that contradicts its spec is refused before it is queued', () => {
  const spec = specFor('cambia il colore della tazza', { edit: true })
  assert.equal(specRefusals(spec, { sourceShape: '3:4', aspect: '3:4' }).length, 0)
  // A frame the line did not ask to change.
  const reshaped = specRefusals(spec, { sourceShape: '3:4', aspect: '9:16' })
  assert.equal(reshaped.length, 1)
  assert.match(reshaped[0] ?? '', /did not ask to change the frame/)
  // The line asked for the new shape: it is not a violation.
  const asked = specFor('falla 9:16', { edit: true })
  assert.deepEqual(specRefusals(asked, { sourceShape: '3:4', aspect: '9:16' }), [])
  // A denoise that redraws the whole frame is not a preserved framing.
  const redraw = specRefusals(spec, { fields: { '53.denoise': 0.9 } })
  assert.equal(redraw.length, 1)
  assert.match(redraw[0] ?? '', /redraws the whole frame/)
  assert.deepEqual(specRefusals(spec, { fields: { '53.denoise': 0.4 } }), [])
  // A line that asks to change the framing may use it.
  const reframed = specFor('rifai l’inquadratura da zero', { edit: true })
  assert.deepEqual(specRefusals(reframed, { fields: { '53.denoise': 0.9 } }), [])
})

test('a change never adds nudity or explicit content the line did not ask for', () => {
  // The defect of 2026-11-21: "more sensual" became a nude.
  const refused = explicitnessRefusal('una donna nuda in un campo', 'rendila più sensuale')
  assert.match(refused ?? '', /nudity/)
  assert.match(refused ?? '', /More sensual.*is not.*nude/)
  // The words the user wrote are permission.
  assert.equal(explicitnessRefusal('una donna nuda in un campo', 'una donna nuda in un campo'), undefined)
  assert.equal(explicitnessRefusal('una donna in un campo', 'rendila più sensuale'), undefined)
  // Explicit content is the same fault.
  assert.match(explicitnessRefusal('contenuto esplicito', 'una coppia al parco') ?? '', /explicitness/)
})
