/**
 * The config's paths: anchored to the file, except the virtual prefixes.
 *
 * `custom:<id>` is not a file but the graph of a personal workflow, read by the
 * loader from `<data>/custom-workflows/<id>/graph.json`. Anchoring it like a
 * relative path turned it into `/data/imagine/custom:<id>` and the boot died
 * with ENOENT (2026-11-04, first personal entry migrated).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { absoluteFrom, anchoredToolComfy, isVirtualWorkflowPath } from '../server/src/config-paths.ts'

const CONFIG = '/data/imagine/config.yaml'

test('a relative path is anchored to the config folder', () => {
  assert.equal(absoluteFrom(CONFIG, './workflows/a.json'), '/data/imagine/workflows/a.json')
  assert.equal(absoluteFrom(CONFIG, '/already/absolute.json'), '/already/absolute.json')
})

test('`custom:<id>` is not a file and stays as it is', () => {
  assert.equal(isVirtualWorkflowPath('custom:abc-123'), true)
  assert.equal(isVirtualWorkflowPath('/data/imagine/data/comfy/workflows/a.json'), false)
  const block = anchoredToolComfy(CONFIG, {
    outputDir: 'media/outputs',
    persona: { path: 'persona/vera.json' },
    workflows: {
      genere: { path: '/data/imagine/data/comfy/workflows/a.json', outputExt: 'webp' },
      personale: { path: 'custom:3f1c2a00-0000-4000-8000-000000000000', outputExt: 'webp', promptNodeId: '73' },
      relativo: { path: './workflows/comfyui_x.json' },
      senzaPath: { outputExt: 'mp4' },
    },
  })
  assert.equal(block.outputDir, '/data/imagine/media/outputs')
  assert.deepEqual(block.persona, { path: '/data/imagine/persona/vera.json' })
  const workflows = block.workflows as Record<string, { path?: string; outputExt?: string; promptNodeId?: string }>
  assert.equal(workflows.genere?.path, '/data/imagine/data/comfy/workflows/a.json')
  assert.equal(workflows.personale?.path, 'custom:3f1c2a00-0000-4000-8000-000000000000')
  // The entry's other fields stay as written.
  assert.equal(workflows.personale?.outputExt, 'webp')
  assert.equal(workflows.personale?.promptNodeId, '73')
  assert.equal(workflows.relativo?.path, '/data/imagine/workflows/comfyui_x.json')
  assert.equal(workflows.senzaPath?.path, undefined)
})
