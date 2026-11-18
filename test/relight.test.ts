/**
 * "Relight the photo": the 17 looks, the default and the light gate.
 *
 * The look IS the prompt: the run does not send a sentence, it sends an id,
 * and the recipe's English text reaches the graph. That is why the list is
 * closed and a made-up light is rejected here, before a job exists — a light
 * that does not exist is not "another light", it is another photo.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_RUNS, invalidChoiceReason, readJobRequest } from '../server/vendor/tool-comfy/job-request.ts'
import {
  DEFAULT_RELIGHT_LOOK, RELIGHT_LOOKS, RELIGHT_PROMPT_PREFIX, relightLookOf, relightPromptOf, relightThumbOf,
} from '../shared/relight-looks.ts'

test('there are seventeen looks, with unique ids, an Italian name and an English sentence', () => {
  assert.equal(RELIGHT_LOOKS.length, 17)
  assert.equal(new Set(RELIGHT_LOOKS.map(look => look.id)).size, 17)
  for (const look of RELIGHT_LOOKS) {
    assert.match(look.id, /^[a-z0-9_]+$/)
    assert.ok(look.name.length > 0 && look.name !== look.nameEn, `Italian name missing for ${look.id}`)
    assert.ok(look.light.startsWith('Light the new photo'), `${look.id}: the sentence is not the recipe one`)
  }
})

test('the default is the recipe\'s first look', () => {
  assert.equal(DEFAULT_RELIGHT_LOOK, RELIGHT_LOOKS[0])
  assert.equal(DEFAULT_RELIGHT_LOOK.id, 'cold_beam')
})

test('a look is found by id, by Italian name and by English name', () => {
  assert.equal(relightLookOf('golden_halo')?.id, 'golden_halo')
  assert.equal(relightLookOf('Alone dorato')?.id, 'golden_halo')
  assert.equal(relightLookOf('Golden halo')?.id, 'golden_halo')
  assert.equal(relightLookOf('  PERSIANE VENEZIANE ')?.id, 'blinds')
  assert.equal(relightLookOf('luce di natale'), undefined)
  assert.equal(relightLookOf(undefined), undefined)
})

test('the thumbnail is a repository file, one per look', () => {
  for (const look of RELIGHT_LOOKS) assert.equal(relightThumbOf(look), `/imagine/relight/${look.id}.webp`)
})

test('the prompt is the recipe instruction plus the look sentence', () => {
  const look = relightLookOf('firelight')
  assert.ok(look !== undefined)
  const prompt = relightPromptOf(look)
  assert.ok(prompt.startsWith(RELIGHT_PROMPT_PREFIX))
  assert.ok(prompt.endsWith(look.light))
  assert.ok(prompt.length > 400, 'the prompt is a full sentence, not a word')
})

test('the fixed instruction is neutral: it names no person, face or identity', () => {
  assert.doesNotMatch(RELIGHT_PROMPT_PREFIX, /\b(person|face|identity|hair|skin|eyes?)\b/i)
  assert.match(RELIGHT_PROMPT_PREFIX, /\bsubject\b/)
  // The look's own sentence is still openjutsu's light; that is not the fixed part.
  for (const look of RELIGHT_LOOKS) assert.ok(relightPromptOf(look).startsWith(RELIGHT_PROMPT_PREFIX))
})

test('relight has its own recipe: an image, the relight tool', () => {
  // A missing ACTION_RUNS entry is no compile error: the runner would fall
  // back to upscale.
  assert.deepEqual(ACTION_RUNS.relight, { workflow: 'relight', tool: 'relight', output: 'image' })
})

test('a made-up light is rejected with the list of the real ones', () => {
  const reason = invalidChoiceReason({ light: 'luce_di_natale' })
  assert.ok(reason !== undefined && reason.includes('cold_beam') && reason.includes('golden_halo'), reason ?? 'no reason')
  for (const look of RELIGHT_LOOKS) assert.equal(invalidChoiceReason({ light: look.id }), undefined, look.id)
  assert.equal(invalidChoiceReason({ light: undefined }), undefined)
})

/** A fake graph: `readJobRequest` only needs it to exist. */
const graph = { graph: {} }

test('with no choice the run uses the first look, and the prompt is not empty', async () => {
  const plan = await readJobRequest({ relight: graph } as never, '/tmp', {
    action: 'relight', prompt: '', source: 'photo.png',
  })
  assert.equal(plan.light, DEFAULT_RELIGHT_LOOK.id)
  assert.equal(plan.prompt, relightPromptOf(DEFAULT_RELIGHT_LOOK))
})

test('the chosen light brings its prompt, and the user\'s line does not replace it', async () => {
  const look = relightLookOf('magenta_club')
  assert.ok(look !== undefined)
  const plan = await readJobRequest({ relight: graph } as never, '/tmp', {
    action: 'relight', prompt: 'falla più scura', source: 'photo.png', light: 'magenta_club',
  })
  assert.equal(plan.light, 'magenta_club')
  assert.equal(plan.prompt, relightPromptOf(look))
})

test('a made-up light never reaches the job: it falls back to the first look', async () => {
  const plan = await readJobRequest({ relight: graph } as never, '/tmp', {
    action: 'relight', prompt: '', source: 'photo.png', light: 'luce_di_natale',
  })
  assert.equal(plan.light, DEFAULT_RELIGHT_LOOK.id)
})

test('relight wants a photo: a clip is the wrong file', async () => {
  await assert.rejects(
    readJobRequest({ relight: graph } as never, '/tmp', {
      action: 'relight', prompt: '', source: 'clip.mp4',
    }),
    /serve un'immagine di partenza/,
  )
})
