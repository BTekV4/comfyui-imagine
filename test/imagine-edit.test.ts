/**
 * The wording of a local photo edit, and the retry rules that keep a
 * correction on the photo it belongs to.
 *
 * The case these cover: on 2026-11-17 two "remove the extra arm" edits on the
 * same photo rewrote the whole picture (the body among it) and never removed
 * the arm, and each retry started from the failed output. No model is called
 * here: the rules are pure, and the wording is checked against prompts shaped
 * like the ones the vision pass wrote that evening.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  editChain, isEditComplaint, isLocalEdit, localEditPrompt, retryEditIntents, LOCAL_EDIT_CHARS, LOCAL_EDIT_KEEP,
  type EditRun,
} from '../shared/imagine-edit.ts'
import { TEMPLATES } from '../shared/imagine-templates.ts'

/** A grounded prompt shaped like the ones written that evening: the change, then a list of the photo. */
const GROUNDED =
  'Remove the extra arm resting along the upper-right side of the figure so that the anatomy looks natural and single, '
  + 'keeping everything else exactly unchanged: the hair, the reclining pose, the navy dress with cream lapel and red trim, '
  + 'the hand holding the yellow toy, the painted nails, the cobblestones and the misty blue backdrop.'

test('a line that names one part of a photo is a local edit', () => {
  for (const line of [
    'Rimuovi il braccio extra',
    'non hai rimosso il braccio extra',
    'togli il cartello dallo sfondo',
    'aggiungi un cappello rosso',
    'metti una tazza sul tavolo',
    'cambia solo il colore della giacca',
    'Remove the extra arm',
    'take out the chair on the left',
    'put a red scarf around her neck',
    'change only the jacket colour',
  ]) {
    assert.equal(isLocalEdit(line), true, `"${line}" should be a local edit`)
  }
})

test('a restyle is not a local edit', () => {
  for (const line of [
    'Redraw it as a 1980s anime cel',
    'trasforma la foto in uno stile dipinto a mano',
    'cambia lo stile in anime',
    'turn this into a watercolour',
    '',
  ]) {
    assert.equal(isLocalEdit(line), false, `"${line}" should stay a free edit`)
  }
})

test('the grounded list of the photo is dropped and the fixed sentence closes the prompt', () => {
  const prompt = localEditPrompt(GROUNDED, 'Remove the extra arm')
  assert.ok(prompt.endsWith(LOCAL_EDIT_KEEP), `ends with the keep sentence: ${prompt}`)
  assert.ok(prompt.length < 400, `short enough, ${String(prompt.length)} characters`)
  for (const listed of ['navy dress', 'painted nails', 'cobblestones', 'reclining pose']) {
    assert.ok(!prompt.includes(listed), `the prompt no longer describes ${listed}`)
  }
  assert.match(prompt, /^Remove the extra arm/)
})

test('a bare instruction is closed with the keep sentence', () => {
  const prompt = localEditPrompt(undefined, 'Remove the extra arm')
  assert.equal(prompt, `Remove the extra arm ${LOCAL_EDIT_KEEP}`)
})

test('a long change with no recital is cut on a word boundary', () => {
  const long = `Remove ${'the extra arm '.repeat(40).trim()} from the photo`
  const prompt = localEditPrompt(long, 'Remove the extra arm')
  const change = prompt.slice(0, prompt.length - LOCAL_EDIT_KEEP.length).trim()
  assert.ok(change.length <= LOCAL_EDIT_CHARS, `${String(change.length)} characters before the keep sentence`)
  assert.ok(!change.endsWith('and') && !change.endsWith(','), `the cut leaves no dangling connector: ${change}`)
  assert.ok(prompt.endsWith(LOCAL_EDIT_KEEP))
})

test('composing the prompt twice does not repeat the keep sentence', () => {
  const once = localEditPrompt(GROUNDED, 'Remove the extra arm')
  const twice = localEditPrompt(once, 'Remove the extra arm')
  assert.equal(twice, once)
})

test('the remove-object template asks for one thing, and composes into a local prompt', () => {
  const template = TEMPLATES.find(entry => entry.id === 'photo-edit')
  const option = template?.fields
    .find(field => field.kind === 'choice' && field.id === 'edit') as { options?: { value: string; prompt?: string }[] } | undefined
  const remove = option?.options?.find(entry => entry.value === 'remove-object')
  assert.ok(remove?.prompt !== undefined, 'the remove-object option has a prompt')
  assert.equal(isLocalEdit(remove.prompt), true)
  const prompt = localEditPrompt(undefined, `${remove.prompt}\nthe extra arm`)
  assert.match(prompt, /extra arm/)
  assert.ok(prompt.endsWith(LOCAL_EDIT_KEEP))
})

/** The chain of an edit: the two failed outputs, the second one being the file the user is asking about. */
const RUNS: readonly EditRun[] = [
  {
    name: 'edit-a.webp',
    action: 'remix',
    prompt: 'Remove this from the photo and rebuild only the area it covered: the extra arm',
    source: 'upload.webp',
  },
  {
    name: 'edit-b.webp',
    action: 'remix',
    prompt: 'Remove the extra arm from the photo',
    source: 'edit-a.webp',
  },
]

test('an edit chain is walked back to the photo it started from', () => {
  assert.deepEqual(editChain('edit-a.webp', RUNS), { root: 'upload.webp', attempts: 1 })
  assert.deepEqual(editChain('edit-b.webp', RUNS), { root: 'upload.webp', attempts: 2 })
})

test('a chain that does not start from a local edit is left alone', () => {
  const style: readonly EditRun[] = [
    { name: 'styled.webp', action: 'remix', prompt: 'Redraw it as an 1980s anime cel', source: 'upload.webp' },
    { name: 'other.webp', action: 'generate', prompt: 'a cat', source: 'upload.webp' },
  ]
  assert.equal(editChain('styled.webp', style), undefined)
  assert.equal(editChain('other.webp', style), undefined)
  assert.equal(editChain('upload.webp', style), undefined)
})

test('a complaint about the last edit is recognised, a request for one more is not', () => {
  for (const line of [
    'non hai rimosso il braccio extra',
    'hai tirato fuori le tette ma il braccio extra ce ancora',
    'il braccio è ancora lì',
    'the arm is still there',
    "it didn't remove the arm",
  ]) {
    assert.equal(isEditComplaint(line), true, `"${line}" reports a failed edit`)
  }
  for (const line of [
    'fammene ancora una',
    'ancora un\'immagine così',
    'genera un\'altra foto',
    'make one more like this',
  ]) {
    assert.equal(isEditComplaint(line), false, `"${line}" asks for a new run`)
  }
})

test('a correction starts from the root, and two failed redraws stop the third', () => {
  const first = retryEditIntents([{ action: 'remix', source: 'edit-a.webp' }], RUNS, 'non hai rimosso il braccio extra')
  assert.equal(first.rewound, true)
  assert.equal(first.escalated, false)
  assert.equal(first.intents[0]?.source, 'upload.webp', 'the first failure is asked of the photo, not of its output')

  const second = retryEditIntents([{ action: 'remix', source: 'edit-b.webp' }], RUNS, 'il braccio extra ce ancora')
  assert.equal(second.escalated, true)
  assert.equal(second.intents.length, 0, 'no third full redraw is queued')

  const plain = retryEditIntents([{ action: 'remix', source: 'edit-b.webp' }], RUNS, 'fammene ancora una')
  assert.equal(plain.rewound, false)
  assert.equal(plain.escalated, false)
  assert.equal(plain.intents[0]?.source, 'edit-b.webp')
})

test('a run that is not a local edit is not touched by the retry rules', () => {
  const styled = [
    { name: 'styled.webp', action: 'remix', prompt: 'Redraw it as an 1980s anime cel', source: 'upload.webp' },
  ]
  const plan = retryEditIntents([{ action: 'remix', source: 'styled.webp' }], styled, 'non hai rimosso il braccio extra')
  assert.equal(plan.rewound, false)
  assert.equal(plan.escalated, false)
  assert.equal(plan.intents[0]?.source, 'styled.webp')
})

test('only a removal hands the work to the masked eraser after two tries', () => {
  const additions: readonly EditRun[] = [
    { name: 'add-a.webp', action: 'remix', prompt: 'Add a red scarf around her neck', source: 'upload.webp' },
    { name: 'add-b.webp', action: 'remix', prompt: 'Add a red scarf around her neck', source: 'add-a.webp' },
  ]
  const plan = retryEditIntents([{ action: 'remix', source: 'add-b.webp' }], additions, 'non hai aggiunto la sciarpa')
  assert.equal(plan.escalated, false, 'an addition is not sent to the eraser')
  assert.equal(plan.rewound, true)
  assert.equal(plan.intents[0]?.source, 'upload.webp')
})
