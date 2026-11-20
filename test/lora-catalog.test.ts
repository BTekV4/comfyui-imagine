/**
 * The LoRA catalog the owner writes in Settings → General: it lives only in
 * the settings file, the studio never reads a LoRA to learn what it is for,
 * and the chat reads it through one function.
 *
 * The fixtures are neutral on purpose: a made-up tag and a made-up purpose.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loraCatalog, loraEntryOf, loraLines, LORA_WEIGHT_RANGE } from '../server/vendor/tool-comfy/lora-catalog.ts'
import { createHostSettings, providerOfGateway } from '../server/src/settings.ts'
import type { HostSettingsValues } from '../shared/host-settings.ts'

test('an entry needs a file and a purpose, and the rest is cleaned up', () => {
  assert.equal(loraEntryOf({ file: '  ', purpose: 'x' }), undefined)
  assert.equal(loraEntryOf({ file: 'tag', purpose: '  ' }), undefined)
  assert.equal(loraEntryOf('tag'), undefined)
  assert.deepEqual(
    loraEntryOf({ file: ' studio-light ', purpose: ' luce da studio ', trigger: ' softbox ', weight: 0.8 }),
    { file: 'studio-light', purpose: 'luce da studio', trigger: 'softbox', weight: 0.8 },
  )
  // A weight outside the range is clamped, not carried to the graph.
  assert.equal(loraEntryOf({ file: 'tag', purpose: 'p', weight: 9 })?.weight, LORA_WEIGHT_RANGE.max)
  assert.equal(loraEntryOf({ file: 'tag', purpose: 'p', weight: -3 })?.weight, LORA_WEIGHT_RANGE.min)
  assert.equal(loraEntryOf({ file: 'tag', purpose: 'p', weight: Number.NaN })?.weight, undefined)
})

test('the catalog keeps the owner order and lists one entry per LoRA', () => {
  const catalog = loraCatalog({
    loraCatalog: [
      { file: 'studio-light', purpose: 'luce da studio', trigger: 'softbox' },
      { file: 'STUDIO-LIGHT', purpose: 'the same one, twice' },
      { file: '', purpose: 'no file' },
    ],
  })
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0]?.purpose, 'luce da studio')
  assert.deepEqual(loraCatalog(undefined), [])
})

test('the line the agent reads says the trigger is literal and the weight advised', () => {
  const text = loraLines([{ file: 'studio-light', purpose: 'luce da studio', trigger: 'softbox', weight: 0.8 }])
  assert.match(text, /luce da studio/)
  assert.match(text, /studio-light/)
  assert.match(text, /"softbox" literally/)
  assert.match(text, /weight 0\.8/)
  assert.equal(loraLines([]), '')
})

const dir = await mkdtemp(join(tmpdir(), 'imagine-lora-catalog-'))
const PROVIDERS = { local: { baseURL: 'http://127.0.0.1:8080/v1' } }
const base: HostSettingsValues = {
  gatewayURL: 'http://127.0.0.1:8080/v1',
  apiKey: '',
  models: [{ provider: 'local', id: 'example/chat-model' }],
  defaultModel: { provider: 'local', model: 'example/chat-model' },
  thinking: 'low',
  resumeSweep: false,
  requireLogin: false,
  hfToken: '',
  autoSetup: false,
  agentChat: 'auto',
  agentMaxSteps: 8,
  agentMaxJobs: 6,
  agentWaitSeconds: 300,
  agentTurnSeconds: 900,
  agentConfirmSeconds: 15,
}

/** The settings page over the file in this test's own folder. */
function settings(name: string) {
  return createHostSettings({
    file: join(dir, `${name}.json`),
    passwordFile: join(dir, `${name}-password.json`),
    envKey: undefined,
    base,
    providers: Object.keys(PROVIDERS),
    providerFor: url => providerOfGateway(PROVIDERS, 'local', url),
  })
}

test('the page saves the catalog, and the host reads it back from the file', async () => {
  const page = await settings('save')
  const view = await page.save({
    loraCatalog: [{ file: 'studio-light', purpose: 'luce da studio', trigger: 'softbox', weight: 0.8 }],
  })
  assert.equal(view.loraCatalog?.length, 1)
  assert.equal(view.loraCatalog?.[0]?.trigger, 'softbox')
  // The chat's reader sees the same thing the page wrote.
  assert.deepEqual(loraCatalog(page.current()).map(card => card.file), ['studio-light'])
})

test('an entry without a purpose is refused, and the saved list is not wiped', async () => {
  const page = await settings('refuse')
  await page.save({ loraCatalog: [{ file: 'studio-light', purpose: 'luce da studio' }] })
  await assert.rejects(
    page.save({ loraCatalog: [{ file: 'studio-light', purpose: '  ' }] }),
    (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error)
      assert.match(text, /LoRA/)
      assert.match(text, /1/)
      return true
    },
  )
  assert.equal(page.current().loraCatalog?.length, 1, 'the list the owner saved is still there')
})

test('the agent is given the catalog, and nothing is said when there is none', async () => {
  const { agentInstruction } = await import('../server/vendor/tool-comfy/agent-prompt.ts')
  const base = {
    request: { text: 'una foto di un faro', history: [], staged: [], recent: [], model: { provider: 'fake', model: 'fake' } },
    known: [],
    eraseTool: false,
    working: [],
    maxSteps: 8,
    maxJobs: 6,
  }
  const card = { file: 'studio-light', purpose: 'luce da studio', trigger: 'softbox', weight: 0.8 }
  const withCatalog = await agentInstruction({ ...base, loraCatalog: [card] })
  assert.match(withCatalog, /LORA THE OWNER LISTED IN SETTINGS/)
  assert.match(withCatalog, /"softbox" literally/)
  // A LoRA of the list is not a missing capability.
  assert.match(withCatalog, /Never answer that "no tool has a slot for a LoRA"/)
  const without = await agentInstruction(base)
  assert.doesNotMatch(without, /LORA THE OWNER LISTED/)
})
