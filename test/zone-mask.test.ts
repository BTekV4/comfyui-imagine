/**
 * The mask a zone edit is handed.
 *
 * A grounded zone is the object's own outline from SAM 3, not the rectangle
 * the vision model drew around it: the graph redraws at denoise 1 and a
 * rectangle makes it invent the background inside the box. A rectangle the
 * user marked stays a rectangle, with rounded corners and an edge feathered in
 * proportion to its size.
 *
 * The segment choice and the proportional amounts are pure; the rounded mask
 * and the graph the run is given run real ffmpeg and the shipped graph, with
 * no ComfyUI.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ImagineHost } from '../server/src/host.ts'
import type { ComfyGraph } from '../server/vendor/comfyui/index.ts'
import type { ImagineRegion } from '../shared/imagine-types.ts'
import type { ImagineSegmentsIndex } from '../shared/imagine-segments.ts'
import { configureComfySetup } from '../server/vendor/tool-comfy/comfy-setup.ts'
import { runWorkflow, type LoadedWorkflow } from '../server/vendor/tool-comfy/index.ts'
import { chooseSegment, regionEdgesFor, writeZoneMask } from '../server/vendor/tool-comfy/region-mask.ts'

const run = promisify(execFile)
const dir = await mkdtemp(join(tmpdir(), 'imagine-zone-mask-'))
after(async () => { await rm(dir, { recursive: true, force: true }) })

/** One photo's analysis, with the segments the tests need. */
function analysis(segments: ImagineSegmentsIndex['segments']): ImagineSegmentsIndex {
  return {
    photo: 'photo.png',
    width: 1000,
    height: 1000,
    createdAt: new Date(0).toISOString(),
    segments,
  }
}

/** A box around the cup in {@link analysis}'s photo. */
const CUP: ImagineRegion = { x: 0.36, y: 0.38, w: 0.26, h: 0.24 }

test('the segment inside the grounding box is the one chosen', () => {
  const index = analysis([
    {
      index: 0, kind: 'object', label: 'coffee cup', score: 0.9,
      bbox: { x: 380, y: 400, w: 220, h: 200 }, area: 0.044, mask: 'm0_mask_000.png', cut: 'm0_cut_000.png',
    },
    {
      index: 1, kind: 'object', label: 'wooden table', score: 0.8,
      bbox: { x: 0, y: 300, w: 1000, h: 700 }, area: 0.7, mask: 'm0_mask_001.png', cut: 'm0_cut_001.png',
    },
  ])
  const chosen = chooseSegment(index, CUP, 'cup')
  assert.equal(chosen?.segment.label, 'coffee cup', 'the table under the cup was chosen instead of the cup')
  assert.ok((chosen?.iou ?? 0) > 0.6)
})

test('a table that swallows the box does not pass for the thing', () => {
  const index = analysis([
    {
      index: 0, kind: 'object', label: 'wooden table', score: 0.99,
      bbox: { x: 0, y: 0, w: 1000, h: 1000 }, area: 0.98, mask: 'm0_mask_000.png', cut: 'm0_cut_000.png',
    },
  ])
  assert.equal(chooseSegment(index, CUP), undefined, 'the whole scene was accepted as the cup')
})

test('nothing in the box is no mask, and a text part does not count', () => {
  const empty = analysis([
    {
      index: 0, kind: 'object', label: 'lamp', score: 0.9,
      bbox: { x: 700, y: 50, w: 200, h: 200 }, area: 0.04, mask: 'm0_mask_000.png', cut: 'm0_cut_000.png',
    },
    {
      index: 1, kind: 'text', label: 'OPEN', score: 0.5,
      bbox: { x: 380, y: 400, w: 220, h: 200 }, area: 0.044, mask: 'm0_mask_001.png', cut: 'm0_cut_001.png',
    },
  ])
  assert.equal(chooseSegment(empty, CUP, 'cup'), undefined)
})

test('the label breaks a tie between two masks of the same box', () => {
  const index = analysis([
    {
      index: 0, kind: 'object', label: 'saucer', score: 0.99,
      bbox: { x: 380, y: 400, w: 220, h: 200 }, area: 0.044, mask: 'm0_mask_000.png', cut: 'm0_cut_000.png',
    },
    {
      index: 1, kind: 'object', label: 'coffee cup', score: 0.5,
      bbox: { x: 380, y: 400, w: 220, h: 200 }, area: 0.044, mask: 'm0_mask_001.png', cut: 'm0_cut_001.png',
    },
  ])
  assert.equal(chooseSegment(index, CUP, 'cup')?.segment.label, 'coffee cup')
})

test('the grow and blur follow the mask, and the crop follows its own scale', () => {
  const small = regionEdgesFor({ w: 60, h: 60 }, 2.5, 1536)
  const big = regionEdgesFor({ w: 300, h: 300 }, 2.5, 1536)
  assert.ok(big.photo.expand > small.photo.expand, 'a bigger mask was not grown more')
  assert.ok(big.photo.blur > small.photo.blur, 'a bigger mask was not softened more')
  // The crop is resized to 1536: its pixels are wider than the photo's, so
  // the same share is more pixels there, and for a small thing much more.
  assert.ok(big.crop.expand > big.photo.expand, 'the crop node was given photo pixels')
  assert.ok(small.crop.expand > small.photo.expand * 3, 'the crop scale was not read')
  // The floor keeps a tiny thing from asking for a zero-pixel blur.
  assert.ok(small.photo.expand >= 2 && small.photo.blur >= 2)
})

/** A fake ComfyUI that records the graph it was handed. */
function fakeRun() {
  let submitted: ComfyGraph | undefined
  const host = {
    comfy: {
      setupCall: async () => ({ ready: true, packs: [], models: [], bytes: 0, unknownClasses: [], unknownFiles: [], substitutions: {} }),
      uploadImage: async (name: string) => ({ name, subfolder: '', type: 'input' }),
      run: async (graph: ComfyGraph) => {
        submitted = graph
        return { promptId: 'p', media: [] }
      },
    },
  } as unknown as ImagineHost
  return { host, submitted: () => submitted }
}

/** The zone graph as this deployment loads it, with its own pins. */
function zoneWorkflow(): LoadedWorkflow {
  const graph = JSON.parse(readFileSync('workflows/comfyui_edit_krea2_region_API.json', 'utf8')) as ComfyGraph
  return { graph, lastImageNodeId: '600', imageNodeId: '76', imageField: 'image' } as unknown as LoadedWorkflow
}

test('the run writes its own proportional grow and blur on the two mask nodes', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const outputDir = await mkdtemp(join(dir, 'run-'))
  const workflow = zoneWorkflow()
  const fake = fakeRun()
  await runWorkflow(fake.host, workflow, outputDir, {}, {
    lastImage: { bytes: new Uint8Array([1, 2, 3]), name: 'mask.png' },
    regionEdges: regionEdgesFor({ w: 300, h: 300 }, 2.5, 1536),
  })
  const graph = fake.submitted()
  assert.ok(graph !== undefined)
  // 603 grows the photo's mask; 610 grows the crop's.
  assert.equal(graph?.['603']?.inputs.expand, regionEdgesFor({ w: 300, h: 300 }, 2.5, 1536).photo.expand)
  assert.equal(graph?.['603']?.inputs.blur_radius, regionEdgesFor({ w: 300, h: 300 }, 2.5, 1536).photo.blur)
  assert.equal(graph?.['610']?.inputs.expand, regionEdgesFor({ w: 300, h: 300 }, 2.5, 1536).crop.expand)
  assert.equal(graph?.['610']?.inputs.blur_radius, regionEdgesFor({ w: 300, h: 300 }, 2.5, 1536).crop.blur)
  // The file in memory keeps the values it was loaded with: only the run's
  // clone is written, or the next zone would inherit this one's size.
  assert.equal(workflow.graph['603']?.inputs.expand, 16)
  assert.equal(workflow.graph['610']?.inputs.expand, 8)
})

test('no edges means the graph keeps the recipe it was saved with', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const outputDir = await mkdtemp(join(dir, 'plain-'))
  const fake = fakeRun()
  await runWorkflow(fake.host, zoneWorkflow(), outputDir, {}, {
    lastImage: { bytes: new Uint8Array([1]), name: 'mask.png' },
  })
  assert.equal(fake.submitted()?.['603']?.inputs.expand, 16)
  assert.equal(fake.submitted()?.['610']?.inputs.expand, 8)
})

test('a rectangle is rounded and leaves the pixels outside it black', async () => {
  const host = {
    comfy: { setupCall: async () => { throw new Error('no ComfyUI in this test') } },
  } as unknown as ImagineHost
  const path = join(dir, 'rounded.png')
  const region: ImagineRegion = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
  const written = await writeZoneMask(host, zoneWorkflow(), dir, 'photo.png', region, 'cup', 320, 240, path)
  assert.equal(written.source, 'rectangle', 'a failed SAM 3 pass must fall back to the rectangle')
  const expected = regionEdgesFor({ w: 160, h: 120 }, 2.5, 1536)
  assert.deepEqual(written.edges, expected)
  const raw = join(dir, 'rounded.raw')
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'gray', raw])
  const pixels = await readFile(raw)
  const at = (x: number, y: number): number => pixels[y * 320 + x] ?? -1
  assert.equal(at(160, 120), 255, 'the middle of the zone is not white')
  assert.equal(at(10, 10), 0, 'a pixel outside the zone is not black')
  assert.equal(at(80, 60), 0, 'the corner was not rounded')
  assert.equal(at(160, 60), 255, 'the middle of the top edge is not white')
})
