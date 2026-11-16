/**
 * The first-run report: every check is read on its own, and one failure does
 * not hide the others (a missing ffmpeg must not stop the card from saying
 * that ComfyUI is fine too).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSetupStatus, NODE_MINIMUM, type SetupProbes } from '../server/src/setup-status.ts'

/** The probes of a machine that is ready, which each test spoils one of. */
function ready(overrides: Partial<SetupProbes> = {}): SetupProbes {
  return {
    version: '0.1.0',
    nodeVersion: '24.9.0',
    ffmpeg: async () => '7.1.1',
    comfyURL: 'http://127.0.0.1:8188',
    comfy: async () => ({
      version: '0.45.2',
      os: 'posix',
      devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 5070 Ti', vramTotal: 16 * 1024 ** 3, vramFree: 12 * 1024 ** 3 }],
      queue: { running: 0, pending: 0 },
    }),
    model: { provider: 'local', model: 'qwen3-vl:8b' },
    providers: ['local'],
    outputDir: '/srv/imagine/data/outputs',
    outputWritable: async () => true,
    ...overrides,
  }
}

test('a ready machine is ok, with the version and the card it found', async () => {
  const report = await readSetupStatus(ready())
  assert.equal(report.ok, true)
  assert.equal(report.version, '0.1.0')
  assert.equal(report.comfy.comfyVersion, '0.45.2')
  assert.deepEqual(report.comfy.devices?.map(device => device.name), ['cuda:0 NVIDIA GeForce RTX 5070 Ti'])
  assert.equal(report.ffmpeg.detail, '7.1.1')
  assert.equal(report.model.id, 'qwen3-vl:8b')
})

test('an old Node is reported with the version it found', async () => {
  const report = await readSetupStatus(ready({ nodeVersion: '22.20.0' }))
  assert.equal(report.ok, false)
  assert.equal(report.node.ok, false)
  assert.equal(report.node.problem, 'node-old')
  assert.equal(report.node.found, '22.20.0')
  assert.equal(report.node.minimum, String(NODE_MINIMUM))
})

test('ffmpeg missing is its own problem, and the other checks still answer', async () => {
  const report = await readSetupStatus(ready({
    ffmpeg: async () => { throw new Error('spawn ffmpeg ENOENT') },
  }))
  assert.equal(report.ok, false)
  assert.equal(report.ffmpeg.problem, 'ffmpeg-missing')
  assert.match(String(report.ffmpeg.detail), /ENOENT/)
  assert.equal(report.comfy.ok, true)
  assert.equal(report.model.ok, true)
})

test('ComfyUI that answers HTTP is told apart from one that answers nothing', async () => {
  const http = await readSetupStatus(ready({
    comfy: async () => { throw new Error('ComfyUI answered HTTP 404 for /system_stats') },
  }))
  assert.equal(http.comfy.problem, 'comfy-http')
  const dead = await readSetupStatus(ready({
    comfy: async () => { throw new Error('fetch failed') },
  }))
  assert.equal(dead.comfy.problem, 'comfy-unreachable')
  assert.equal(dead.comfy.url, 'http://127.0.0.1:8188')
})

test('a model whose provider is not configured says which pair it wants', async () => {
  const missing = await readSetupStatus(ready({ model: undefined }))
  assert.equal(missing.model.problem, 'no-model')
  const unknown = await readSetupStatus(ready({
    model: { provider: 'gateway', model: 'qwen3-vl:8b' },
  }))
  assert.equal(unknown.model.problem, 'provider-missing')
  assert.equal(unknown.model.provider, 'gateway')
})

test('an output folder that cannot be written is reported with its path', async () => {
  const report = await readSetupStatus(ready({
    outputWritable: async () => { throw new Error('EACCES: permission denied') },
  }))
  assert.equal(report.ok, false)
  assert.equal(report.output.problem, 'output-missing')
  assert.equal(report.output.dir, '/srv/imagine/data/outputs')
})
