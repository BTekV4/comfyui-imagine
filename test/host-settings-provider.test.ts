/**
 * The provider the settings' catalog writes on a model it adds.
 *
 * F2 added a model from the catalog and the page wrote the hard-coded
 * `omniroute`, which a `config.yaml` defining only `local` refuses with
 * `llm.unknownProvider` at chat time. The real provider is found by baseURL,
 * and a save naming one the config does not define is refused with a sentence
 * that names the ones it does.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostSettings, providerOfGateway } from '../server/src/settings.ts'
import type { HostSettingsValues } from '../shared/host-settings.ts'

const dir = await mkdtemp(join(tmpdir(), 'imagine-settings-provider-'))
const file = join(dir, 'host-settings.json')
const passwordFile = join(dir, 'password.json')

const PROVIDERS = {
  local: { baseURL: 'http://127.0.0.1:8080/v1' },
  openai: { baseURL: 'https://api.openai.com/v1' },
}

test('the gateway provider is the config entry whose baseURL matches', () => {
  assert.equal(providerOfGateway(PROVIDERS, 'openai', 'http://127.0.0.1:8080/v1'), 'local')
  // A trailing slash is the same address.
  assert.equal(providerOfGateway(PROVIDERS, 'openai', 'https://api.openai.com/v1/'), 'openai')
  // An address no entry has falls back to the provider serving the default model.
  assert.equal(providerOfGateway(PROVIDERS, 'openai', 'http://127.0.0.1:9999/v1'), 'openai')
  assert.equal(providerOfGateway(PROVIDERS, 'gone', 'http://127.0.0.1:9999/v1'), 'local')
})

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

/** The settings page, over the config above. */
function settings() {
  return createHostSettings({
    file,
    passwordFile,
    envKey: undefined,
    base,
    providers: Object.keys(PROVIDERS),
    providerFor: url => providerOfGateway(PROVIDERS, 'local', url),
  })
}

test('the view says which provider this gateway belongs to', async () => {
  const page = await settings()
  const view = page.view()
  assert.equal(view.gatewayProvider, 'local')
})

test('a model the catalog adds with the real provider is saved', async () => {
  const page = await settings()
  const view = await page.save({ models: [{ provider: 'local', id: 'example/chat-model', name: 'Example' }] })
  assert.equal(view.models[0]?.provider, 'local')
})

test('a model naming a provider the config does not define is refused, with the list', async () => {
  const page = await settings()
  await assert.rejects(
    page.save({ models: [{ provider: 'omniroute', id: 'example/chat-model' }] }),
    (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error)
      assert.match(text, /omniroute/)
      assert.match(text, /local/)
      assert.match(text, /openai/)
      return true
    },
  )
})

test('a default model naming an unknown provider is refused too', async () => {
  const page = await settings()
  await assert.rejects(
    page.save({ defaultModel: { provider: 'omniroute', model: 'example/chat-model' } }),
    /omniroute/,
  )
})
