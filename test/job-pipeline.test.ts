/**
 * The job pipeline's small rules: the user's line wins in «Rigenera
 * dettaglio», the header cache is keyed by file, the area canvas of a
 * recreation, and the object swap carrying no window length.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ImagineHost } from '../server/src/host.ts'
import { regeneratePrompt } from '../server/vendor/tool-comfy/regenerate.ts'
import { pixelCache, readJobRequest } from '../server/vendor/tool-comfy/job-request.ts'
import { h3AreaCanvas } from '../server/vendor/tool-comfy/extend-video.ts'

/** A host nobody may touch: a run that uses the user's line asks nothing of it. */
const untouchable = new Proxy({}, {
  get: () => { throw new Error('the host must not be read when the user wrote a line') },
}) as ImagineHost

test('«Rigenera dettaglio»: a line the user wrote wins over the note, vision and the neutral sentence', async () => {
  const prompt = await regeneratePrompt(untouchable, 'missing.mp4', '/nonexistent/missing.mp4', undefined, '  a red dress, golden hour  ')
  assert.equal(prompt, 'a red dress, golden hour')
})

test('pixelCache: one read per path and kind, a different file gets its own', () => {
  const pixelsOf = pixelCache()
  const first = pixelsOf('/nonexistent/a.png', 'image')
  assert.equal(pixelsOf('/nonexistent/a.png', 'image'), first)
  assert.notEqual(pixelsOf('/nonexistent/b.png', 'image'), first)
  assert.notEqual(pixelsOf('/nonexistent/a.png', 'video'), first)
})

test('h3AreaCanvas: the native area on the clip ratio, on the 32 grid', () => {
  assert.deepEqual(h3AreaCanvas(720, 1280), { width: 768, height: 1344 })
  const half = h3AreaCanvas(720, 1280, 0.4768)
  assert.ok(half !== undefined && half.width % 32 === 0 && half.height % 32 === 0)
  assert.equal(h3AreaCanvas(0, 1280), undefined)
  assert.equal(h3AreaCanvas(Number.NaN, 1280), undefined)
})

test('an object swap carries no canvas: its graph sizes the render from planResolution', async () => {
  const plan = await readJobRequest({ objectSwapAdd: { graph: {} } } as never, '/tmp', {
    action: 'objectSwap', prompt: 'aggiungi un vaso', source: 'clip.mp4', objectMode: 'add', size: '1080x1920',
  })
  assert.equal(plan.size, undefined)
})

test('a new picture takes a style reference only when its graph has that input', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'imagine-style-ref-'))
  await writeFile(join(dir, 'ref.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  // The graph that ships draws from text alone: a reference would be dropped.
  await assert.rejects(
    readJobRequest({ generate: { graph: { '1': { class_type: 'KSampler', inputs: {} } } } } as never, dir, {
      action: 'generate', prompt: 'un faro in stile fumetto', reference: 'ref.png',
    }),
    /refImageNodeId/,
  )
  // A graph that declares the second image branch carries it to the run.
  const plan = await readJobRequest({
    generate: { graph: { '9': { class_type: 'LoadImage', inputs: {} } }, refImageNodeId: '9' },
  } as never, dir, { action: 'generate', prompt: 'un faro in stile fumetto', reference: 'ref.png' })
  assert.equal(plan.reference, 'ref.png')
})
