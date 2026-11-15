/**
 * A settings file written while the windowed object swap's pins and the long
 * upscale's combine node were still fields keeps loading: those fields are
 * dropped, the rest of the layer applies, and the loader ignores them in a
 * `config.yaml` entry too. Setting one from the page is still refused.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'imagine-settings-'))
process.env.IMAGINE_HOME = home
const { applyOverrideOps, imagineSettingsPath, loadImagineOverrides } = await import('../server/vendor/tool-comfy/imagine-settings.ts')
const { loadWorkflows } = await import('../server/vendor/tool-comfy/workflow-load.ts')

test('retired fields in the settings file are dropped, not refused', async () => {
  await mkdir(join(home, 'comfy'), { recursive: true })
  await writeFile(imagineSettingsPath(), JSON.stringify({
    version: 1,
    workflows: {
      objectSwap: {
        seedNodeId: '7',
        sceneText: { nodeId: 'sc', field: 'value' },
        windowStart: { nodeId: 'ws', field: 'value' },
        canvasMegapixels: 0.98,
      },
      upscaleVideoLong: { metaBatchNodeId: '30', videoCombineNodeId: '15' },
    },
  }))
  const read = loadImagineOverrides()
  assert.equal(read.problem, undefined)
  assert.deepEqual(read.overrides.workflows, { objectSwap: { seedNodeId: '7' }, upscaleVideoLong: { metaBatchNodeId: '30' } })
})

test('the page cannot set a retired field', () => {
  const { errors } = applyOverrideOps({}, [{ op: 'set', path: ['workflows', 'objectSwap', 'sceneText'], value: { nodeId: 'a', field: 'b' } }])
  assert.equal(errors.length, 1)
})

test('a config entry that still carries them loads, without them', async () => {
  const graphFile = join(home, 'swap.json')
  await writeFile(graphFile, JSON.stringify({ tg: { class_type: 'PrimitiveString', inputs: { value: 'object' } } }))
  const { byRun } = loadWorkflows({
    objectSwap: {
      path: graphFile,
      subjectText: { nodeId: 'tg', field: 'value' },
      sceneText: { nodeId: 'tg', field: 'value' },
      windowStart: { nodeId: 'tg', field: 'value' },
      canvasMegapixels: 0.98,
    },
  } as never)
  const loaded = byRun.objectSwap as unknown as Record<string, unknown>
  assert.deepEqual(loaded.subjectText, { nodeId: 'tg', field: 'value' })
  assert.equal(loaded.sceneText, undefined)
  assert.equal(loaded.windowStart, undefined)
  assert.equal(loaded.canvasMegapixels, undefined)
})
