/**
 * The four Pika clip graphs carry both recipes in one file since 2026-11-15:
 * the fast one as saved, the quality one as the entry's `highInputs`. Each
 * recipe must submit exactly the graph its old file was (kept here as
 * `test/fixtures/pika-pairs/<action>_{fast,quality}.json`), the SaveVideo
 * prefix aside. Both sides go through the real path: the entries of
 * `config.example.yaml` loaded by `loadWorkflows` and parameterized by
 * `runWorkflow`, against the same entry pointing at the two old files with
 * `pathHigh`, which stays supported.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const home = await mkdtemp(join(tmpdir(), 'imagine-pika-'))
process.env.IMAGINE_HOME = home
const { runWorkflow } = await import('../server/vendor/tool-comfy/index.ts')
const { loadWorkflows } = await import('../server/vendor/tool-comfy/workflow-load.ts')
const { configureComfySetup } = await import('../server/vendor/tool-comfy/comfy-setup.ts')
const { applyHighInputs } = await import('../server/vendor/tool-comfy/high-inputs.ts')
type ComfyGraph = import('../server/vendor/comfyui/index.ts').ComfyGraph
type LoadedWorkflow = import('../server/vendor/tool-comfy/index.ts').LoadedWorkflow
type ImagineHost = import('../server/src/host.ts').ImagineHost

const ROOT = resolve(import.meta.dirname, '..')
const FIXTURES = join(ROOT, 'test', 'fixtures', 'pika-pairs')

/** Each old pair: the fixture name and the config entry that now runs it. */
const PAIRS = [
  { name: 'i2v', entry: 'createVideo', run: 'video' },
  { name: 'i2v', entry: 'recreateVideo', run: 'recreateVideo' },
  { name: 'loop', entry: 'loopVideo', run: 'loopVideo' },
  { name: 'extend', entry: 'extendVideo', run: 'extendVideo' },
  { name: 'song', entry: 'videoOnSong', run: 'videoOnSong' },
] as const

const example = parseYaml(readFileSync(join(ROOT, 'config.example.yaml'), 'utf8')) as {
  toolComfy: { workflows: Record<string, Record<string, unknown>> }
}
const exampleWorkflows = example.toolComfy.workflows

/** A config entry with its paths made absolute, as `config-paths.ts` does at boot. */
function entryOf(key: string): Record<string, unknown> {
  const entry = exampleWorkflows[key]
  assert.ok(entry !== undefined, `config.example.yaml has no ${key}`)
  return { ...entry, path: resolve(ROOT, String(entry.path)) }
}

function fixture(name: string, recipe: 'fast' | 'quality'): ComfyGraph {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}_${recipe}.json`), 'utf8')) as ComfyGraph
}

/** The graph with every SaveVideo prefix set to one value, the one difference allowed. */
function samePrefix(graph: ComfyGraph): ComfyGraph {
  const copy = structuredClone(graph)
  for (const node of Object.values(copy)) {
    if (node.class_type === 'SaveVideo') node.inputs.filename_prefix = 'video/Pika'
  }
  return copy
}

/** The nodes an output reaches, walking links upstream from every SaveVideo. */
function reachable(graph: ComfyGraph): ComfyGraph {
  const seen = new Set<string>()
  const pending = Object.entries(graph).filter(([, node]) => node.class_type === 'SaveVideo').map(([id]) => id)
  while (pending.length > 0) {
    const id = pending.pop()!
    if (seen.has(id) || graph[id] === undefined) continue
    seen.add(id)
    for (const value of Object.values(graph[id].inputs)) {
      if (Array.isArray(value) && typeof value[0] === 'string') pending.push(value[0])
    }
  }
  return Object.fromEntries(Object.entries(graph).filter(([id]) => seen.has(id)))
}

/** A ComfyUI that answers ready and records the graph checked and the graph sent. */
function fakeHost() {
  const seen: { checked?: ComfyGraph; submitted?: ComfyGraph } = {}
  const host = {
    comfy: {
      setupCall: async (_route: string, body: { prompt: ComfyGraph }) => {
        seen.checked = structuredClone(body.prompt)
        return { ready: true, packs: [], models: [], bytes: 0, unknownClasses: [], unknownFiles: [] }
      },
      uploadImage: async (name: string) => ({ name, subfolder: '', type: 'input' }),
      uploadVideo: async (name: string) => ({ name, subfolder: '', type: 'input' }),
      run: async (graph: ComfyGraph) => { seen.submitted = graph; return { promptId: 'p', media: [] } },
    },
  } as unknown as ImagineHost
  return { host, seen }
}

/** Run one loaded workflow through `runWorkflow` and return what was checked and sent. */
async function submitted(workflow: LoadedWorkflow, slow: boolean): Promise<{ checked: ComfyGraph; sent: ComfyGraph }> {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const fake = fakeHost()
  const outputDir = await mkdtemp(join(home, 'out-'))
  await runWorkflow(fake.host, workflow, outputDir, { seed: 1234, ...slow ? { speed: 'slow' as const } : {} })
  assert.ok(fake.seen.checked !== undefined && fake.seen.submitted !== undefined)
  return { checked: fake.seen.checked, sent: fake.seen.submitted }
}

for (const pair of PAIRS) {
  test(`${pair.entry}: one graph renders both old ${pair.name} recipes`, async () => {
    const merged = entryOf(pair.entry)
    assert.equal(merged.pathHigh, undefined, 'the example no longer needs a second graph')
    assert.ok(Array.isArray(merged.highInputs) && merged.highInputs.length > 0)

    // The same entry and pins on the two old files, the way `pathHigh` loads them.
    const dir = await mkdtemp(join(home, `${pair.name}-`))
    const fastFile = join(dir, 'fast.json')
    const qualityFile = join(dir, 'quality.json')
    await writeFile(fastFile, JSON.stringify(fixture(pair.name, 'fast')))
    await writeFile(qualityFile, JSON.stringify(fixture(pair.name, 'quality')))
    const { highInputs: _unused, ...pins } = merged
    const old = loadWorkflows({ [pair.entry]: { ...pins, path: fastFile, pathHigh: qualityFile } } as never).byRun
    const now = loadWorkflows({ [pair.entry]: merged } as never).byRun

    const runs = old as unknown as Record<string, LoadedWorkflow | undefined>
    const oldFast = runs[pair.run]
    const oldQuality = old.high?.[pair.run]
    const merge = (now as unknown as Record<string, LoadedWorkflow | undefined>)[pair.run]
    assert.ok(oldFast !== undefined && oldQuality !== undefined && merge !== undefined)
    assert.equal(now.high?.[pair.run], undefined)

    for (const slow of [false, true]) {
      const expected = await submitted(slow ? oldQuality : oldFast, slow)
      const actual = await submitted(merge, slow)
      const recipe = slow ? 'quality' : 'fast'
      assert.deepEqual(samePrefix(actual.sent), samePrefix(expected.sent), `${recipe} graph sent`)
      // The setup check is asked about the same nodes, so no unused model either.
      assert.deepEqual(samePrefix(actual.checked), samePrefix(expected.checked), `${recipe} graph checked`)
    }
  })

  test(`${pair.entry}: the merged file, overridden and pruned, is the old ${pair.name} pair`, () => {
    const entry = entryOf(pair.entry)
    const file = JSON.parse(readFileSync(String(entry.path), 'utf8')) as ComfyGraph
    const loaded = (loadWorkflows({ [pair.entry]: entry } as never).byRun as unknown as Record<string, LoadedWorkflow>)[pair.run]!
    for (const recipe of ['fast', 'quality'] as const) {
      const graph = structuredClone(file)
      applyHighInputs(graph, loaded.highInputs, recipe === 'quality')
      assert.deepEqual(samePrefix(reachable(graph)), samePrefix(reachable(fixture(pair.name, recipe))), recipe)
      // The overrides' own pruning already gives the old file, nodes no
      // SaveVideo reaches (the song's latent saver) included.
      assert.deepEqual(samePrefix(graph), samePrefix(fixture(pair.name, recipe)), `${recipe}: pruned by the overrides alone`)
    }
  })
}

test('a highInputs pin that does not resolve fails the run on either recipe', () => {
  const graph: ComfyGraph = {
    '1': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '2': { class_type: 'ManualSigmas', inputs: { sigmas: '1.0, 0.0' } },
  }
  for (const high of [false, true]) {
    assert.throws(() => applyHighInputs(structuredClone(graph), [{ nodeId: '9', field: 'sampler_name', value: 'lcm' }], high), /no node at 9/)
    assert.throws(() => applyHighInputs(structuredClone(graph), [{ nodeId: '1', field: 'sampler', value: 'lcm' }], high), /no input sampler/)
    assert.throws(() => applyHighInputs(structuredClone(graph), [{ nodeId: '1', field: 'sampler_name', value: ['7', 0] }], high), /no node at 7/)
  }
})

test('the loader keeps only usable overrides, and the pathHigh graph takes none', async () => {
  const dir = await mkdtemp(join(home, 'loader-'))
  const file = join(dir, 'graph.json')
  await writeFile(file, JSON.stringify({ '1': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } } }))
  const { byRun } = loadWorkflows({
    loopVideo: {
      path: file,
      pathHigh: file,
      highInputs: [
        { nodeId: '1', field: 'sampler_name', value: 'lcm' },
        { nodeId: '1', field: 'sampler_name' },
        { nodeId: '', field: 'sampler_name', value: 'lcm' },
        { nodeId: '1', field: 'sampler_name', value: { nested: true } },
        { nodeId: '1', field: 'x', value: ['2', 0] },
      ],
    },
  } as never)
  const loaded = byRun.loopVideo as unknown as LoadedWorkflow
  assert.deepEqual(loaded.highInputs, [
    { nodeId: '1', field: 'sampler_name', value: 'lcm' },
    { nodeId: '1', field: 'x', value: ['2', 0] },
  ])
  assert.equal(byRun.high?.loopVideo?.highInputs, undefined)
})

test('a config from before the merge still loads: the old pair becomes the merged graph and its highInputs', async () => {
  const { migrateRetiredPika, RETIRED_PIKA_PAIRS } = await import('../server/vendor/tool-comfy/high-inputs.ts')
  const workflows: Record<string, Record<string, unknown>> = {}
  for (const { name, entry } of PAIRS) {
    const { highInputs: _high, ...rest } = entryOf(entry)
    workflows[entry] = {
      ...rest,
      path: join(ROOT, 'workflows', `comfyui_video_${name}_pika_fast_API.json`),
      pathHigh: join(ROOT, 'workflows', `comfyui_video_${name}_pika_quality_API.json`),
    }
  }
  const { rows, byRun } = loadWorkflows(workflows as never)
  for (const { entry, run } of PAIRS) {
    const row = rows.find(candidate => candidate.run === run)
    assert.ok(row?.loaded !== undefined, `${entry} loads`)
    assert.deepEqual(row.loaded.highInputs, exampleWorkflows[entry]?.highInputs, `${entry}: the overrides of config.example.yaml`)
    assert.equal(byRun.high?.[run], undefined, `${entry}: no pathHigh graph left`)
  }
  // The table names every merged graph config.example.yaml ships, with its overrides.
  for (const { name, entry } of PAIRS) {
    const retired = RETIRED_PIKA_PAIRS[`comfyui_video_${name}_pika_fast_API.json`]
    assert.equal(retired?.file, String(exampleWorkflows[entry]?.path).split('/').pop())
    assert.deepEqual(retired?.highInputs, exampleWorkflows[entry]?.highInputs)
  }
  // A deployment that keeps its own copies of the old files is left alone.
  const kept = migrateRetiredPika({ path: '/srv/x/comfyui_video_i2v_pika_fast_API.json', pathHigh: '/srv/x/q.json' }, () => true)
  assert.equal(kept.migrated, false)
})
