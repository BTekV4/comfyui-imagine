/**
 * What the studio remembers about a picture it edits, and the one-step levers.
 *
 * The state is filed under the studio's data root, so this file owns its own
 * `IMAGINE_HOME` and loads the modules that read it after setting it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'imagine-edit-state-'))
process.env['IMAGINE_HOME'] = home

const mediaDir = await mkdtemp(join(tmpdir(), 'imagine-edit-media-'))
/** A real 1x1 PNG: the tools check that the source is in the gallery. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
await writeFile(join(mediaDir, 'photo.png'), ONE_PIXEL_PNG)

const { editStateNotes, recallEditState, rememberEditState } = await import('../server/vendor/tool-comfy/edit-state.ts')
const { resolveStep, stepAsked } = await import('../server/vendor/tool-comfy/edit-levers.ts')
const { runAgentTool } = await import('../server/vendor/tool-comfy/agent-tools.ts')

/** The state of a picture with one accepted result, and one failed try. */
function acceptedState(): import('../server/vendor/tool-comfy/edit-state.ts').EditState {
  return {
    accepted: {
      file: 'old-result.webp',
      change: 'cambia il colore della tazza',
      spec: { change: 'cambia il colore della tazza', preserve: ['framing', 'text', 'subjects', 'style', 'format'], intensity: 'as-asked' },
      verdict: {
        requestedChangeDone: true,
        preservedOk: { framing: true, text: true, subjects: true, style: true, format: true },
        textFound: [],
        unrequestedChanges: [],
        identicalToSource: false,
        missing: [],
      },
    },
    lastVerdict: {
      requestedChangeDone: true,
      preservedOk: { framing: true, text: true, subjects: true, style: true, format: true },
      textFound: [],
      unrequestedChanges: [],
      identicalToSource: false,
      missing: [],
    },
    failed: [],
  }
}

/** The tool deps one edit_image call needs, with a fake start. */
function toolDeps(asked: string, started: unknown[]): import('../server/vendor/tool-comfy/agent-tools.ts').AgentToolDeps {
  return {
    ctx: {} as never,
    outputDir: mediaDir,
    asked,
    eraseTool: false,
    start: async (body) => { started.push(body); return [] },
    jobView: job => job as never,
    listJobs: () => [],
    getJob: () => undefined,
    adoptFiles: async () => undefined,
    cancelJob: async () => true,
    known: [],
    canQueue: () => 6,
    say: () => undefined,
  }
}

test('a step is the accepted change plus one delta from the closed list', () => {
  const step = resolveStep('rendila più luminosa', 'cambia il colore della tazza')
  assert.deepEqual(step, { change: 'cambia il colore della tazza, luce più luminosa' })
  // Without an accepted result there is nothing to step from: the model's
  // prompt, which is the user's own words, stands.
  assert.equal(resolveStep('rendila più luminosa'), undefined)
  // An unknown lever is refused even without an accepted result.
  assert.equal(resolveStep('rendila più sensuale') !== undefined, true)
  assert.deepEqual(resolveStep('make it more colourful', 'the mug is blue'), { change: 'the mug is blue, more vivid colours' })
  assert.deepEqual(resolveStep('falla più calda', 'the mug is blue'), { change: 'the mug is blue, toni più caldi' })
  // A line that is not a step is left to the model.
  assert.equal(resolveStep('cambia il colore della tazza'), undefined)
  assert.equal(stepAsked('cambia il colore della tazza'), false)
  // "Sensuale" is not a lever, and the refusal says which ones exist.
  const refused = resolveStep('rendila più sensuale', 'cambia il colore della tazza')
  assert.equal(refused !== undefined && 'error' in refused, true)
  assert.match(refused !== undefined && 'error' in refused ? refused.error : '', /not one of the studio's steps/)
})

test('the picture state round-trips, and the instruction reads it', async () => {
  await rememberEditState('photo.png', acceptedState())
  const back = await recallEditState('photo.png')
  assert.equal(back?.accepted?.change, 'cambia il colore della tazza')
  assert.equal(back?.accepted?.file, 'old-result.webp')
  assert.deepEqual(back?.failed, [])
  // A file that was never filed has no state.
  assert.equal(await recallEditState('never-edited.png'), undefined)
  const notes = await editStateNotes(['photo.png', 'never-edited.png'])
  assert.deepEqual(notes, ['- photo.png: last accepted «cambia il colore della tazza» as old-result.webp'])
})

test('a "più X" on a picture starts from the accepted result, and a non-lever is refused', async () => {
  await rememberEditState('photo.png', acceptedState())
  const started: { prompt?: string }[] = []
  const outcome = await runAgentTool('edit_image', { prompt: 'falla più luminosa', source: 'photo.png' }, toolDeps('rendila più luminosa', started) as never)
  assert.equal(outcome.result['ok'], true)
  assert.equal(started[0]?.prompt, 'cambia il colore della tazza, luce più luminosa')

  const blocked: { prompt?: string }[] = []
  const refused = await runAgentTool('edit_image', { prompt: 'falla più sensuale', source: 'photo.png' }, toolDeps('rendila più sensuale', blocked) as never)
  assert.equal(refused.result['ok'], false)
  assert.match(String(refused.result['error'] ?? ''), /not one of the studio's steps/)
  assert.equal(blocked.length, 0)
})

test('a local fault is fixed through a zone, not by redrawing the whole photo', async () => {
  const state = acceptedState()
  await rememberEditState('photo.png', {
    ...state,
    lastVerdict: {
      requestedChangeDone: true,
      preservedOk: { framing: true, text: true, subjects: true, style: true, format: true },
      textFound: [],
      unrequestedChanges: [],
      identicalToSource: false,
      missing: ['the lettering OPEN is gone'],
    },
    failed: [{ signature: 'sig-1', change: 'cambia il colore della tazza', reason: 'the lettering OPEN is gone' }],
  })
  // The same change again, with no zone: refused, because the fix is local.
  const whole: unknown[] = []
  const refused = await runAgentTool('edit_image', { prompt: 'cambia il colore della tazza', source: 'photo.png' }, toolDeps('cambia il colore della tazza', whole) as never)
  assert.equal(refused.result['ok'], false)
  assert.match(String(refused.result['error'] ?? ''), /local correction/)
  assert.equal(whole.length, 0)
  // With a zone it runs: only that part is redrawn.
  const zoned: unknown[] = []
  const ran = await runAgentTool('edit_image', {
    prompt: 'cambia il colore della tazza',
    source: 'photo.png',
    region: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
  }, toolDeps('cambia il colore della tazza', zoned) as never)
  assert.equal(ran.result['ok'], true)
  assert.equal(zoned.length, 1)
})
