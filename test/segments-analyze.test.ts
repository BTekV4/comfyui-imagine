/**
 * «Segmenti» end to end against a fake ComfyUI and vision model: the setup
 * check, the vision pass and the upload start together, a failed check stops
 * the vision pass, and the masks and cut-outs come down a few at a time.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImagineHost } from '../server/src/host.ts'

// The data root is read once, at import: point it at a scratch folder first.
const home = await mkdtemp(join(tmpdir(), 'imagine-segments-'))
process.env.IMAGINE_HOME = home
const { startSegments, segmentsStatus } = await import('../server/vendor/tool-comfy/segments.ts')
const { setImagineModels } = await import('../server/vendor/tool-comfy/imagine-models.ts')

const SEGMENTS = Array.from({ length: 8 }, (_, index) => ({
  index, kind: 'object', label: `thing ${String(index)}`, score: 0.9, bbox: { x: 0, y: 0, w: 1, h: 1 }, area: 0.1,
  mask: `seg_00001_mask_${String(index).padStart(3, '0')}.png`, cut: `seg_00001_cut_${String(index).padStart(3, '0')}.png`,
}))

/** A fake host; `checkFails` makes the setup check refuse the graph. */
function fakeHost(options: { checkFails?: boolean } = {}) {
  const events: string[] = []
  let inFlight = 0
  let peak = 0
  let lookAborted = false
  const media = [
    { filename: 'seg_00001_index.json' },
    ...SEGMENTS.flatMap(segment => [{ filename: segment.mask }, { filename: segment.cut }]),
  ]
  const host = {
    auxiliary: {
      analyzeImage: async (_path: string, _prompt: string, _route: unknown, opts?: { signal?: AbortSignal }) => {
        events.push('look')
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50)
          opts?.signal?.addEventListener('abort', () => { lookAborted = true; clearTimeout(timer); resolve() }, { once: true })
        })
        if (opts?.signal?.aborted === true) throw new Error('aborted')
        return { text: '{"objects": [{"name": "cup", "count": 1}], "texts": []}' }
      },
    },
    comfy: {
      setupCall: async () => {
        events.push('check')
        if (options.checkFails === true) return { ready: false, packs: [], models: [], bytes: 0, unknownClasses: ['ImagineSegments'], unknownFiles: [] }
        return undefined
      },
      uploadImage: async (name: string) => { events.push('upload'); return { name, subfolder: '', type: 'input' } },
      run: async () => { events.push('run'); return { promptId: 'p', media } },
      fetchMediaTo: async (ref: { filename: string }, target: string) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        await writeFile(target, ref.filename.endsWith('_index.json')
          ? JSON.stringify({ width: 10, height: 10, segments: SEGMENTS })
          : 'png')
        inFlight -= 1
      },
    },
  } as unknown as ImagineHost
  return { host, events, peak: () => peak, lookAborted: () => lookAborted }
}

/** Wait for the photo's analysis to leave «running». */
async function settled(photo: string) {
  for (let i = 0; i < 200; i += 1) {
    const status = await segmentsStatus(photo)
    if (status.state !== 'running') return status
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('still running')
}

test('the check, the look and the upload start together; the files come down six at a time', async () => {
  setImagineModels({ vision: { provider: 'p', model: 'm' } })
  const outputDir = await mkdtemp(join(tmpdir(), 'imagine-gallery-'))
  await writeFile(join(outputDir, 'photo.png'), 'bytes')
  const fake = fakeHost()
  await startSegments(fake.host, outputDir, 'photo.png')
  const status = await settled('photo.png')
  assert.equal(status.state, 'ready')
  if (status.state === 'ready') assert.equal(status.index.model, 'p/m')
  // All three are under way before the look (50 ms) answers.
  assert.deepEqual(fake.events.slice(0, 3).sort(), ['check', 'look', 'upload'])
  assert.equal(fake.events[3], 'run')
  assert.ok(fake.peak() > 1 && fake.peak() <= 6, `peak ${String(fake.peak())}`)
  const files = await readdir(join(home, 'comfy', 'segments', 'photo.png'))
  assert.equal(files.length, SEGMENTS.length * 2 + 1)
})

test('a ComfyUI that cannot run the graph stops the vision pass', async () => {
  setImagineModels({ vision: { provider: 'p', model: 'm' } })
  const outputDir = await mkdtemp(join(tmpdir(), 'imagine-gallery-'))
  await writeFile(join(outputDir, 'other.png'), 'bytes')
  const fake = fakeHost({ checkFails: true })
  await startSegments(fake.host, outputDir, 'other.png')
  const status = await settled('other.png')
  assert.equal(status.state, 'failed')
  assert.equal(fake.lookAborted(), true)
  assert.ok(!fake.events.includes('run'))
})
