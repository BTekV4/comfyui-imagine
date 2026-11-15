/**
 * "Edit object": the contract of the four modes and the graph gate.
 *
 * The two mistakes this file keeps out are the invisible ones: `ACTION_RUNS`
 * is `Partial`, so a missing entry is not a compile error but sends the run
 * to the upscale graph; and a mode without a graph that started anyway would
 * render a video with the wrong thing changed.
 *
 * There is one graph per mode (`objectSwap`, `objectSwapRemove`,
 * `objectSwapBackground`), and `add` has none yet: it must stop with
 * `job.objectSwapNotConfigured` even when the other three are configured.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_RUNS, invalidChoiceReason, placementKeyframes, placementOf, readJobRequest } from '../server/vendor/tool-comfy/job-request.ts'
import { objectSwapUsesPhoto, objectTrackOf } from '../server/vendor/tool-comfy/object-swap-texts.ts'
import { DEFAULT_OBJECT_PLACEMENT, IMAGINE_ACTIONS, IMAGINE_OBJECT_MODES } from '../shared/imagine-types.ts'

/** A fake graph: `readJobRequest` only needs it to exist; the runner reads the pins. */
const graph = { graph: {} }

test('the four modes are in the contract, in order', () => {
  assert.deepEqual(IMAGINE_OBJECT_MODES, ['change', 'remove', 'background', 'add'])
  assert.ok((IMAGINE_ACTIONS as readonly string[]).includes('objectSwap'))
})

test('objectSwap has its own recipe, not the upscale one', () => {
  // A missing entry in ACTION_RUNS is not a compile error: the runner would
  // fall back to the video upscale.
  assert.deepEqual(ACTION_RUNS.objectSwap, { workflow: 'objectSwap', tool: 'object_swap', output: 'video' })
})

test('an invented mode is rejected with the list of the real ones', () => {
  const reason = invalidChoiceReason({ objectMode: 'teleport' })
  assert.ok(reason !== undefined && reason.includes('change') && reason.includes('remove')
    && reason.includes('background') && reason.includes('add'), reason ?? 'no reason')
  for (const mode of IMAGINE_OBJECT_MODES) assert.equal(invalidChoiceReason({ objectMode: mode }), undefined, mode)
  assert.equal(invalidChoiceReason({ objectMode: undefined }), undefined)
})

test('a mode without a graph stops with its message instead of starting', async () => {
  // No graph configured: the situation of a deployment that does not have the
  // `objectSwap*` entries in config.yaml yet.
  await assert.rejects(
    readJobRequest({}, '/tmp', { action: 'objectSwap', prompt: 'togli la bottiglia', objectMode: 'remove' }),
    /object swap non è configurato per il modo «remove»/,
  )
})

test('the message names the requested mode, and change is the default', async () => {
  await assert.rejects(
    readJobRequest({}, '/tmp', { action: 'objectSwap', prompt: 'cambia l\'oggetto' }),
    /modo «change»/,
  )
})

test('add stays off until its config section exists', async () => {
  const workflows = { objectSwap: { graph: {} }, objectSwapRemove: { graph: {} }, objectSwapBackground: { graph: {} } }
  await assert.rejects(
    readJobRequest(workflows as never, '/tmp', { action: 'objectSwap', prompt: 'aggiungi un vaso', objectMode: 'add' }),
    /modo «add»/,
  )
})

test('add without a box uses the one at the centre of the frame', async () => {
  // The chat does not draw on the video: without a box the object goes in the centre.
  const plan = await readJobRequest({ objectSwapAdd: graph } as never, '/tmp', {
    action: 'objectSwap', prompt: 'aggiungi un vaso sul tavolo', source: 'clip.mp4', objectMode: 'add',
  })
  assert.equal(plan.objectMode, 'add')
  assert.deepEqual(plan.placement, DEFAULT_OBJECT_PLACEMENT)
})

test('add carries the box the request names', async () => {
  const placement = { x: 0.1, y: 0.2, width: 0.4, height: 0.5 }
  const plan = await readJobRequest({ objectSwapAdd: graph } as never, '/tmp', {
    action: 'objectSwap', prompt: 'aggiungi un vaso', source: 'clip.mp4', objectMode: 'add', placement,
  })
  assert.deepEqual(plan.placement, placement)
})

test('the box reaches the node as a one-element JSON keyframe list', async () => {
  // This is the shape H3ObjectPlacementMask reads: a box that stays still for
  // the whole clip. The node accepts a second keyframe (a moving camera); the
  // studio does not draw one yet.
  assert.deepEqual(JSON.parse(placementKeyframes({ x: 0.1, y: 0.2, width: 0.4, height: 0.5 })), [
    { frame: 0, x: 0.1, y: 0.2, width: 0.4, height: 0.5 },
  ])
})

test('an impossible box is rejected with the right message', () => {
  // Outside the frame, with no area, or with a value that is not a number: it
  // is a mask, not a preference, so it is rejected instead of corrected.
  for (const bad of [
    { x: -0.1, y: 0.1, width: 0.2, height: 0.2 },
    { x: 0.9, y: 0.1, width: 0.3, height: 0.2 },
    { x: 0.1, y: 0.1, width: 0, height: 0.2 },
    { x: 0.1, y: 0.1, width: 0.2, height: -0.2 },
    { x: '0.1', y: 0.1, width: 0.2, height: 0.2 },
    { width: 0.2, height: 0.2 },
    null as unknown,
  ]) {
    assert.equal(placementOf(bad), undefined, JSON.stringify(bad))
    assert.match(invalidChoiceReason({ placement: bad }) ?? '', /dentro il fotogramma/, JSON.stringify(bad))
  }
  const ok = { x: 0, y: 0.25, width: 1, height: 0.5 }
  assert.deepEqual(placementOf(ok), ok)
  assert.equal(invalidChoiceReason({ placement: ok }), undefined)
  assert.equal(invalidChoiceReason({ placement: undefined }), undefined)
})

test('add with a photo resolves to the photo graph, add without one to its own', async () => {
  // The two graphs of the "add" mode differ in the photo branch: with the
  // wrong one, the photo would not reach the render (or would condition a run
  // that did not ask for it).
  const withPhoto = await readJobRequest({ objectSwapAddPhoto: graph, objectSwapAdd: { graph: { other: true } } } as never, '/tmp', {
    action: 'objectSwap', prompt: 'aggiungi questa zucca sul tavolo', source: 'clip.mp4', objectMode: 'add', reference: 'zucca.png',
  })
  assert.equal(withPhoto.reference, 'zucca.png')
  const withoutPhoto = await readJobRequest({ objectSwapAddPhoto: { graph: { other: true } }, objectSwapAdd: graph } as never, '/tmp', {
    action: 'objectSwap', prompt: 'aggiungi un palloncino', source: 'clip.mp4', objectMode: 'add',
  })
  assert.equal(withoutPhoto.reference, undefined)
  // A photo for "add" is not a rejection: it is what the object looks like.
  assert.equal(objectSwapUsesPhoto('add'), true)
})

test('the high recipe of add follows the photo too', async () => {
  // «Qualità alta» picks the mode's second graph: an «add» with a photo must
  // take the high graph of the photo branch, never the one without it.
  const high = { graph: { high: true } }
  const highPhoto = { graph: { highPhoto: true } }
  const workflows = {
    objectSwapAdd: graph,
    objectSwapAddPhoto: graph,
    high: { objectSwapAdd: high, objectSwapAddPhoto: highPhoto },
  }
  const withPhoto = await readJobRequest(workflows as never, '/tmp', {
    action: 'objectSwap', prompt: 'aggiungi questa zucca', source: 'clip.mp4', objectMode: 'add', reference: 'zucca.png', quality: 'high',
  })
  assert.equal(withPhoto.workflow, highPhoto)
  const withoutPhoto = await readJobRequest(workflows as never, '/tmp', {
    action: 'objectSwap', prompt: 'aggiungi un vaso', source: 'clip.mp4', objectMode: 'add', quality: 'high',
  })
  assert.equal(withoutPhoto.workflow, high)
})

test('add with a photo but without the photo graph stays off', async () => {
  await assert.rejects(
    readJobRequest({ objectSwapAdd: graph } as never, '/tmp', {
      action: 'objectSwap', prompt: 'aggiungi questa zucca', source: 'clip.mp4', objectMode: 'add', reference: 'zucca.png',
    }),
    /modo «add»/,
  )
})

test('change without a photo stops before touching the files', async () => {
  // With the mode's graph configured the gate passes and the photo check is
  // reached; the file does not exist, but the rejection comes before opening it.
  await assert.rejects(
    readJobRequest({ objectSwap: graph } as never, '/tmp', {
      action: 'objectSwap', prompt: 'cambia la bottiglia', source: 'clip.mp4',
    }),
    /foto dell'oggetto da mettere nella scena/,
  )
})

test('remove takes no photo, and a photo sent is a rejection', async () => {
  await assert.rejects(
    readJobRequest({ objectSwapRemove: graph } as never, '/tmp', {
      action: 'objectSwap', prompt: 'togli la bottiglia', source: 'clip.mp4', objectMode: 'remove', reference: 'bottiglia.png',
    }),
    /non usa una foto/,
  )
})

test('the photo belongs to change and add, not to remove or background', () => {
  assert.equal(objectSwapUsesPhoto('change'), true)
  assert.equal(objectSwapUsesPhoto('add'), true)
  assert.equal(objectSwapUsesPhoto('remove'), false)
  // The background graph has no image branch: a photo sent would never reach
  // the render, and the client would believe it had been used.
  assert.equal(objectSwapUsesPhoto('background'), false)
})

test('remove with its graph and no photo resolves', async () => {
  const plan = await readJobRequest({ objectSwapRemove: graph } as never, '/tmp', {
    action: 'objectSwap', prompt: 'togli la bottiglia', source: 'clip.mp4', objectMode: 'remove',
  })
  assert.equal(plan.objectMode, 'remove')
  assert.equal(plan.reference, undefined)
  assert.equal(plan.source, 'clip.mp4')
})

test('background without a photo resolves to its graph', async () => {
  const plan = await readJobRequest({ objectSwapBackground: graph } as never, '/tmp', {
    action: 'objectSwap', prompt: 'in una cucina anni ottanta', source: 'clip.mp4', objectMode: 'background',
  })
  assert.equal(plan.objectMode, 'background')
  assert.equal(plan.reference, undefined)
})

test('background rejects the photo: its graph has no image branch', async () => {
  await assert.rejects(
    readJobRequest({ objectSwapBackground: graph } as never, '/tmp', {
      action: 'objectSwap', prompt: 'metti questo posto', source: 'clip.mp4', objectMode: 'background', reference: 'cucina.png',
    }),
    /il modo «background» non usa una foto/,
  )
})

test('change with a photo resolves to the change graph', async () => {
  const plan = await readJobRequest({ objectSwap: graph } as never, '/tmp', {
    action: 'objectSwap', prompt: 'metti questa bottiglia', source: 'clip.mp4', reference: 'bottiglia.png',
  })
  assert.equal(plan.objectMode, 'change')
  assert.equal(plan.reference, 'bottiglia.png')
})

test('the tracker phrase does not name the person', () => {
  // This is what the vision model wrote on the first real run (2026-11-06): the
  // mask took the person, the hand came back orange and the woman in the photo
  // ended up in the clip.
  assert.equal(objectTrackOf('person, torso, body, clothing'), 'clothing')
  assert.equal(objectTrackOf('woman, blue dress'), 'blue dress')
  assert.equal(objectTrackOf('young woman, black top'), 'black top')
})

test('if the tracker names only people, the phrase becomes `object`', () => {
  assert.equal(objectTrackOf('woman, person, torso'), 'object')
  assert.equal(objectTrackOf('hand'), 'object')
})

test('objects stay as they are', () => {
  assert.equal(objectTrackOf('blue dress, denim'), 'blue dress, denim')
  assert.equal(objectTrackOf('bottle, glass'), 'bottle, glass')
})
