/**
 * The H3 graphs that plan their own clips take an explicit `width`/`height`,
 * and their nodes accept only positive multiples of 32. The composer's 720p at
 * 9:16 is 720x1280 and 720 is not on that grid, so every chained video was
 * refused before drawing a frame (measured on 2026-11-17: the Production Plan
 * node raised "H3 chain width and height must be positive multiples of 32").
 *
 * The size is snapped on the finished graph, so both a saved workflow and a
 * request carrying 720x1280 end up at the frame ResolutionSelector's own
 * arithmetic lands on (736x1312), while the still graphs keep the size they
 * were given. A node that refuses a parameter is deterministic, so the client
 * marks it as a rejected graph and the chain's retry leaves it alone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImagineHost } from '../server/src/host.ts'
import type { ComfyGraph } from '../server/vendor/comfyui/index.ts'
import { ComfyUi, isGraphValidationError } from '../server/vendor/comfyui/index.ts'
import { h3Frame } from '../shared/imagine-sizing.ts'
import { runWorkflow, type LoadedWorkflow } from '../server/vendor/tool-comfy/index.ts'
import { configureComfySetup } from '../server/vendor/tool-comfy/comfy-setup.ts'

const GRAPH: ComfyGraph = {
  '24': { class_type: 'MiniMaxH3ChainPlanModern', inputs: { plan_json: '{}', run_name: 'test', width: 720, height: 1280 } },
  '52': { class_type: 'EmptyLatentImage', inputs: { width: 1080, height: 1920, batch_size: 1 } },
}

const WORKFLOW = { graph: GRAPH, sizeNodeId: '24' } as unknown as LoadedWorkflow

/** A fake ComfyUI that accepts the setup check and records the graph it ran. */
function fakeHost(events: string[]) {
  let submitted: ComfyGraph | undefined
  const host = {
    comfy: {
      setupCall: async () => {
        events.push('check')
        return { ready: true, packs: [], models: [], bytes: 0, unknownClasses: [], unknownFiles: [], substitutions: {} }
      },
      run: async (graph: ComfyGraph) => {
        events.push('run')
        submitted = graph
        return { promptId: 'p', media: [] }
      },
    },
  } as unknown as ImagineHost
  return { host, submitted: () => submitted }
}

test('the frames that failed land on the node grid', () => {
  // The real failures: 720p at 9:16, 720 is not a multiple of 32.
  assert.deepEqual(h3Frame(720, 1280), { width: 736, height: 1312 })
  assert.deepEqual(h3Frame(1280, 720), { width: 1312, height: 736 })
  // 480p at 9:16: 480 is on the grid, the long side is not.
  assert.deepEqual(h3Frame(480, 848), { width: 480, height: 864 })
  assert.deepEqual(h3Frame(848, 480), { width: 864, height: 480 })
  // A frame already on the grid does not move.
  assert.deepEqual(h3Frame(1088, 1920), { width: 1088, height: 1920 })
  assert.deepEqual(h3Frame(480, 864), { width: 480, height: 864 })
  assert.equal(h3Frame(0, 1280), undefined)
  assert.equal(h3Frame(720, Number.NaN), undefined)
})

test('the bundled chain graphs are saved on the grid', () => {
  for (const kind of ['i2v', 'loop', 'extend']) {
    const path = new URL(`../workflows/comfyui_video_${kind}_chain_API.json`, import.meta.url)
    const graph = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    const plan = Object.values(graph).find(node => node.class_type === 'MiniMaxH3ChainPlanModern')
    assert.ok(plan !== undefined, `${kind}: no Production Plan node`)
    assert.equal(plan.inputs.width, 736, `${kind}: width`)
    assert.equal(plan.inputs.height, 1312, `${kind}: height`)
  }
})

test('a saved H3 plan node is submitted on the grid, the still graph untouched', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const events: string[] = []
  const fake = fakeHost(events)
  const outputDir = await mkdtemp(join(tmpdir(), 'imagine-h3-'))
  await runWorkflow(fake.host, WORKFLOW, outputDir, {}, {})
  assert.deepEqual(events, ['check', 'run'])
  const graph = fake.submitted()
  assert.equal(graph?.['24']?.inputs.width, 736)
  assert.equal(graph?.['24']?.inputs.height, 1312)
  // The still graph is not an H3 node: its frame is exactly what the file had.
  assert.equal(graph?.['52']?.inputs.width, 1080)
  assert.equal(graph?.['52']?.inputs.height, 1920)
  // The loaded graph is never touched.
  assert.equal(GRAPH['24']?.inputs.width, 720)
})

test('a request size that is off the grid is snapped too, and never sent as it was', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const events: string[] = []
  const fake = fakeHost(events)
  const outputDir = await mkdtemp(join(tmpdir(), 'imagine-h3-'))
  await runWorkflow(fake.host, WORKFLOW, outputDir, { size: '720x1280' }, {})
  const graph = fake.submitted()
  assert.equal(graph?.['24']?.inputs.width, 736)
  assert.equal(graph?.['24']?.inputs.height, 1312)
})

test('a frame that is not positive is refused before the graph is sent', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const events: string[] = []
  const fake = fakeHost(events)
  const broken = {
    graph: { '24': { class_type: 'MiniMaxH3ChainPlanModern', inputs: { width: 0, height: 1280 } } },
    sizeNodeId: '24',
  } as unknown as LoadedWorkflow
  const outputDir = await mkdtemp(join(tmpdir(), 'imagine-h3-'))
  await assert.rejects(
    runWorkflow(fake.host, broken, outputDir, {}, {}),
    (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === 'COMFY_GRAPH_REJECTED',
  )
  assert.deepEqual(events, [])
})

test('node refusals are deterministic, runtime failures are not', () => {
  assert.equal(isGraphValidationError('H3 chain width and height must be positive multiples of 32.\n'), true)
  assert.equal(
    isGraphValidationError('TrimAudioDuration: Start time must be less than end time and be within the audio length.\n'),
    true,
  )
  assert.equal(isGraphValidationError('CUDA out of memory. Tried to allocate 2.00 GiB'), false)
  assert.equal(isGraphValidationError('The sizes of tensors must match except in dimension 1'), false)
  assert.equal(isGraphValidationError('ComfyUI run x failed'), false)
})

test('a refused frame reaches the caller as a rejected graph, not a generic failure', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/system_stats') return Response.json({ system: { os: 'posix' } })
    if (url.pathname === '/prompt') return Response.json({ prompt_id: 'p', number: 1 })
    if (url.pathname === '/history/p') {
      return Response.json({
        p: {
          status: {
            status_str: 'error',
            messages: [['execution_error', { exception_message: 'H3 chain width and height must be positive multiples of 32.\n' }]],
          },
        },
      })
    }
    if (url.pathname === '/queue' && (init?.method ?? 'GET') === 'GET') {
      return Response.json({ queue_running: [], queue_pending: [] })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  try {
    const comfy = new ComfyUi({ baseURL: 'http://comfy.test', preview: false })
    await assert.rejects(
      comfy.run({ '24': { class_type: 'MiniMaxH3ChainPlanModern', inputs: { width: 720, height: 1280 } } }),
      (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === 'COMFY_GRAPH_REJECTED',
    )
  } finally {
    globalThis.fetch = original
  }
})
