/**
 * The beat the model reads, and the caption the person reads.
 *
 * A story's plan is written once, in English, because the video model reads
 * the beat directly. On a page in another language the studio shows the same
 * shot as a short caption, and the director writes both in the same reply: one
 * call, no second wait. These tests pin the two halves apart — the beats stay
 * English, the captions are in the page's language, and an English page or an
 * old story is exactly what it was. The reply that fills the captions the
 * director left out is `story-caption-fallback.test.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { storyPlanInstruction, writeStoryPlan } from '../server/vendor/tool-comfy/story.ts'
import type { ImagineHost } from '../server/src/host.ts'

/** A host whose text model answers with one fixed reply. */
function hostSaying(reply: string): ImagineHost {
  return {
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: reply }
      },
    },
  } as unknown as ImagineHost
}

/** A reply in the shape the brief asks for: beats, then their captions. */
const ANSWER = `1. The camera pushes in while she dances under a neon sign.
2. She turns towards the lens as the light flickers.

Captions:
1. La ragazza balla sotto un'insegna al neon.
2. Si gira verso l'obiettivo mentre la luce tremola.`

/** A plan answer with no caption block at all. */
const BEATS_ONLY = `1. The camera pushes in while she dances under a neon sign.
2. She turns towards the lens as the light flickers.`

test('an Italian page asks for captions in the same reply, and the beats stay English', () => {
  const brief = storyPlanInstruction('a girl dances', [6, 6], { opening: false, captionLanguage: 'it' })
  assert.match(brief, /Write every beat in English/)
  assert.match(brief, /Captions:/)
  assert.match(brief, /in Italiano/)
  assert.match(brief, /not sent to the video model/)
})

test('an English page asks for nothing more than the beats', () => {
  for (const brief of [
    storyPlanInstruction('a girl dances', [6], { opening: false }),
    storyPlanInstruction('a girl dances', [6], { opening: false, captionLanguage: 'en' }),
    storyPlanInstruction('a girl dances', [6], { opening: false, captionLanguage: 'en-GB' }),
  ]) {
    assert.doesNotMatch(brief, /Captions:/)
    assert.match(brief, /Write every beat in English/)
  }
})

test('the plan keeps the English beats and the Italian captions apart', async () => {
  const plan = await writeStoryPlan(hostSaying(ANSWER), 'a girl dances', [6, 6], {
    opening: false,
    captionLanguage: 'it',
    model: { provider: 'fake', model: 'm' },
  })
  assert.deepEqual(plan.beats, [
    'The camera pushes in while she dances under a neon sign.',
    'She turns towards the lens as the light flickers.',
  ])
  assert.deepEqual(plan.captions, [
    "La ragazza balla sotto un'insegna al neon.",
    'Si gira verso l\'obiettivo mentre la luce tremola.',
  ])
  assert.equal(plan.captionLanguage, 'it')
})

test('a director that answered only the beats is asked once more, and shows the beat when that fails too', async () => {
  let calls = 0
  const host = {
    llm: {
      async *stream() {
        calls += 1
        // The plan, then a fallback that gets nothing back.
        if (calls > 1) throw new Error('the model is down')
        yield { type: 'text-delta', text: BEATS_ONLY }
      },
    },
  } as unknown as ImagineHost
  const plan = await writeStoryPlan(host, 'a girl dances', [6, 6], {
    opening: false,
    captionLanguage: 'it',
    model: { provider: 'fake', model: 'm' },
  })
  assert.equal(plan.beats.length, 2)
  // Nothing is shown under a caption label: the shot keeps its English beat,
  // which is what the studio showed before captions existed.
  assert.deepEqual(plan.captions, ['', ''])
  assert.equal(calls, 2)
})

test('an English page drops a caption block the model wrote anyway', async () => {
  const plan = await writeStoryPlan(hostSaying(ANSWER), 'a girl dances', [6, 6], {
    opening: false,
    model: { provider: 'fake', model: 'm' },
  })
  assert.equal(plan.captions, undefined)
  assert.equal(plan.captionLanguage, undefined)
})

test('a caption block shorter than the film keeps the shots it does not cover', async () => {
  const reply = `1. The camera pushes in.
2. She turns.
3. The light dies.

Captions:
1. La camera avanza.`
  const plan = await writeStoryPlan(hostSaying(reply), 'x', [6, 6, 6], {
    opening: false,
    captionLanguage: 'it',
    model: { provider: 'fake', model: 'm' },
  })
  assert.deepEqual(plan.captions, ['La camera avanza.', '', ''])
})
