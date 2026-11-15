/**
 * The check before a run (comfy-setup.ts) against a fake ComfyUI that answers
 * like comfyui-imagine's setup routes: nothing to do, something it cannot
 * install, asking the user first, installing with progress, restarting when
 * a node pack came in, and an install that fails. Plus the job queue's wait
 * for the user's yes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ImagineHost } from '../server/src/host.ts'
import { configureComfySetup, ensureComfyReady, type SetupProgress } from '../server/vendor/tool-comfy/comfy-setup.ts'
import { approveSetup, waitForSetupApproval } from '../server/vendor/tool-comfy/job-queue.ts'

const PLAN = {
  packs: [{ id: 'comfyui-krea2edit', name: 'Krea 2 Identity Edit', version: '1.2.3', source: 'registry', registryStatus: 'Active', installedNotLoaded: false }],
  models: [{ name: 'qwen_image_vae.safetensors', folder: 'vae', size: 253806246 }],
  bytes: 253806246,
}
const READY = { ready: true, packs: [], models: [], bytes: 0, unknownClasses: [], unknownFiles: [] }
const MISSING = { ready: false, ...PLAN, unknownClasses: [], unknownFiles: [] }

/** A fake ComfyUI: `check` answers from a list, `status` walks an install. */
function fakeComfy(checks: unknown[], task: { restart?: boolean; fail?: string } = {}) {
  const calls: { route: string; body?: unknown; headers?: Record<string, string> }[] = []
  let polls = 0
  let boot = 1
  let installing = false
  const host = {
    comfy: {
      setupCall: async (route: string, body?: unknown, headers?: Record<string, string>) => {
        calls.push({ route, body, headers })
        if (checks.length === 0 && route === 'check') return undefined
        if (route === 'check') return checks.shift()
        if (route === 'install') { installing = true; return { state: 'running' } }
        if (route === 'restart') { boot = 2; return { restarting: true } }
        // Like the real pack: idle until the install is asked for, running right after.
        if (!installing) return { boot, task: { state: 'idle' } }
        polls += 1
        if (polls < 3) return { boot, task: { state: 'running', file: 'qwen_image_vae.safetensors', done: 100, total: 200, etaSeconds: 7 } }
        return { boot, task: task.fail === undefined ? { state: 'done', restart: task.restart === true } : { state: 'failed', error: task.fail } }
      },
    },
  } as unknown as ImagineHost
  return { host, calls }
}

test('a ComfyUI without the pack, or with everything, is left as it is', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const without = fakeComfy([])
  await ensureComfyReady(without.host, {})
  assert.deepEqual(without.calls.map(call => call.route), ['check'])
  const ready = fakeComfy([READY])
  await ensureComfyReady(ready.host, {})
  assert.deepEqual(ready.calls.map(call => call.route), ['check'])
})

test('the file the pack chose for this GPU is written in the graph', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'krea2_turbo_int8_convrot.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b_int8_convrot.safetensors' } },
  }
  const { host } = fakeComfy([{ ...READY, substitutions: { 'krea2_turbo_int8_convrot.safetensors': 'krea2_turbo_nvfp4.safetensors' } }])
  await ensureComfyReady(host, graph)
  assert.equal(graph['1'].inputs.unet_name, 'krea2_turbo_nvfp4.safetensors')
  assert.equal(graph['2'].inputs.clip_name, 'qwen3vl_4b_int8_convrot.safetensors', 'the others stay')
})

test('after an install the substitution of the last check is applied', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: true }), 5)
  const graph = { '1': { class_type: 'UNETLoader', inputs: { unet_name: 'krea2_turbo_int8_convrot.safetensors' } } }
  const subs = { 'krea2_turbo_int8_convrot.safetensors': 'krea2_turbo_nvfp4.safetensors' }
  const { host } = fakeComfy([{ ...MISSING, substitutions: subs }, { ...READY, substitutions: subs }])
  await ensureComfyReady(host, graph)
  assert.equal(graph['1'].inputs.unet_name, 'krea2_turbo_nvfp4.safetensors')
})

test('what the pack cannot install is reported by name', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: true }), 5)
  const { host } = fakeComfy([{ ...READY, ready: false, unknownClasses: ['FL_InpaintCrop'], unknownFiles: ['mine.safetensors'] }])
  await assert.rejects(ensureComfyReady(host, {}), /FL_InpaintCrop, mine\.safetensors/)
})

test('with nobody to ask and the switch off, nothing is installed', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const { host, calls } = fakeComfy([MISSING])
  await assert.rejects(ensureComfyReady(host, {}), /Krea 2 Identity Edit, qwen_image_vae\.safetensors \(0\.3 GB\)/)
  assert.equal(calls.some(call => call.route === 'install'), false)
})

test('after the yes: install with the token, progress, restart for a node pack, then the run goes on', async () => {
  configureComfySetup(() => ({ hfToken: 'hf_secret', autoSetup: false }), 5)
  const { host, calls } = fakeComfy([MISSING, READY], { restart: true })
  let asked: unknown
  let finished = false
  const seen: SetupProgress[] = []
  await ensureComfyReady(host, {}, { approve: async (plan) => { asked = plan }, progress: (state) => { seen.push(state) }, done: () => { finished = true } })
  assert.equal(finished, true)
  assert.deepEqual(asked, { packs: [{ id: 'comfyui-krea2edit', name: 'Krea 2 Identity Edit', source: 'registry', registryStatus: 'Active' }], models: PLAN.models, bytes: PLAN.bytes })
  const install = calls.find(call => call.route === 'install')
  assert.deepEqual(install?.body, { packs: ['comfyui-krea2edit'], models: ['qwen_image_vae.safetensors'] })
  assert.equal(install?.headers?.['X-HF-Token'], 'hf_secret')
  assert.ok(seen.some(state => state.stage === 'qwen_image_vae.safetensors' && state.percent === 50 && state.etaSeconds === 7))
  assert.equal(seen.at(-1)?.stage, 'restart')
  assert.ok(calls.some(call => call.route === 'restart'))
  assert.equal(calls.at(-1)?.route, 'check')
})

test('with «Install automatically» on nobody is asked', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: true }), 5)
  const { host, calls } = fakeComfy([MISSING, READY])
  await ensureComfyReady(host, {}, { approve: async () => { throw new Error('must not ask') } })
  assert.ok(calls.some(call => call.route === 'install'))
  assert.equal(calls.some(call => call.route === 'restart'), false)
})

const pack = (source: string, registryStatus?: string) => ({
  ...MISSING,
  packs: [{ id: 'some-pack', name: 'Some Pack', source, ...registryStatus === undefined ? {} : { registryStatus } }],
})

test('a flagged, unchecked or GitHub node pack is asked for even with «Install automatically» on', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: true }), 5)
  for (const answer of [pack('registry', 'Flagged'), pack('registry'), pack('github')]) {
    const { host, calls } = fakeComfy([answer, READY])
    let asked = false
    await ensureComfyReady(host, {}, { approve: async () => { asked = true } })
    assert.equal(asked, true)
    const refused = fakeComfy([answer])
    await assert.rejects(ensureComfyReady(refused.host, {}), /Some Pack/)
    assert.equal(refused.calls.some(call => call.route === 'install'), false)
    assert.ok(calls.some(call => call.route === 'install'))
  }
})

test('a node pack the registry banned is never installed', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: false }), 5)
  const { host, calls } = fakeComfy([pack('registry', 'Banned')])
  await assert.rejects(ensureComfyReady(host, {}, { approve: async () => { throw new Error('must not ask') } }), /(banned|bandito) Some Pack/)
  assert.equal(calls.some(call => call.route === 'install'), false)
})

test('a failed install stops the run with the reason', async () => {
  configureComfySetup(() => ({ hfToken: '', autoSetup: true }), 5)
  const { host } = fakeComfy([MISSING], { fail: 'checksum mismatch' })
  await assert.rejects(ensureComfyReady(host, {}), /checksum mismatch/)
})

test('the job waits for the yes; a stop ends the wait', async () => {
  const yes = waitForSetupApproval('job-yes', { packs: [], models: [], bytes: 0 })
  assert.equal(approveSetup('job-yes'), true)
  await yes
  assert.equal(approveSetup('job-yes'), false, 'answered once')
  const controller = new AbortController()
  const no = waitForSetupApproval('job-no', { packs: [], models: [], bytes: 0 }, controller.signal)
  controller.abort()
  await assert.rejects(no)
  assert.equal(approveSetup('job-no'), false)
})
