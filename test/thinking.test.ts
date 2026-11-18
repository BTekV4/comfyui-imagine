/**
 * The thinking level: where the list comes from, what ends up in the request,
 * and that a save from the page applies from the next call without reloading
 * the process.
 *
 * Since 2026-11-06 the list is **not ours**: the gateway declares it for each
 * model in `/v1/models` → `capabilities.effort_tiers`. This checks that it is
 * read from there, that the declared tier ends up in the body as
 * `reasoning_effort` (even one we do not know) and that a gateway that does not
 * answer breaks nothing.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_LIMITS_DEFAULT } from '../shared/agent-chat.ts'
import type { HostSettingsValues } from '../shared/host-settings.ts'

const { createLlm, thinkingBody } = await import('../server/src/llm.ts')
const { createHostSettings } = await import('../server/src/settings.ts')

const root = await mkdtemp(join(tmpdir(), 'imagine-thinking-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

test('the mapping: any declared tier is sent as reasoning_effort, one shape only', () => {
  // No list in here: what the gateway declared is sent.
  for (const level of ['none', 'minimal', 'low', 'medium', 'xhigh', 'ultra']) {
    assert.deepEqual(thinkingBody(level), { reasoning_effort: level })
    assert.equal('chat_template_kwargs' in thinkingBody(level), false)
  }
})

/** An LLM whose fetches go nowhere: the chat bodies, and `/models`. */
function fakeLlm(options: { thinking: () => unknown; tiers?: readonly string[] }) {
  const bodies: Record<string, unknown>[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init: { body?: string }) => {
    if (new URL(url).pathname.endsWith('/models')) {
      const capabilities = options.tiers === undefined ? {} : { effort_tiers: options.tiers }
      return new Response(JSON.stringify({ data: [{ id: 'm', capabilities }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    bodies.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>)
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const created = createLlm(
    () => ({ prova: { baseURL: 'http://gateway.test/v1', apiKey: 'prova' } }),
    () => undefined,
    options.thinking,
  )
  return { ...created, bodies, restore: () => { globalThis.fetch = real } }
}

test('the levels are read from /models, field capabilities.effort_tiers', async () => {
  const llm = fakeLlm({ thinking: () => 'low', tiers: ['none', 'low', 'xhigh'] })
  try {
    assert.deepEqual(await llm.thinkingLevels({ provider: 'prova', model: 'm' }), ['none', 'low', 'xhigh'])
  } finally {
    llm.restore()
  }
  // A model that declares nothing does not invent a list.
  const empty = fakeLlm({ thinking: () => 'low' })
  try {
    assert.deepEqual(await empty.thinkingLevels({ provider: 'prova', model: 'm' }), [])
  } finally {
    empty.restore()
  }
})

test('the text request carries the current level, read on every call', async () => {
  let level: unknown = 'low'
  const llm = fakeLlm({ thinking: () => level })
  try {
    const drain = async (): Promise<void> => {
      for await (const _ of llm.llm.stream({ provider: 'prova', model: 'm', messages: [{ role: 'user', content: 'hello' }] })) {
        // The body is what is checked.
      }
    }
    await drain()
    assert.deepEqual(llm.bodies.at(-1)?.reasoning_effort, 'low')
    assert.equal('chat_template_kwargs' in (llm.bodies.at(-1) ?? {}), false)

    // The save reloads nothing: the next request reads the new value.
    level = 'none'
    await drain()
    assert.deepEqual(llm.bodies.at(-1)?.reasoning_effort, 'none')

    // Even a tier the code does not know: the gateway declared it.
    level = 'xhigh'
    await drain()
    assert.deepEqual(llm.bodies.at(-1)?.reasoning_effort, 'xhigh')

    // A value that does not have the shape of a tier does not reach the gateway.
    level = 'Altissimo!'
    await drain()
    assert.deepEqual(llm.bodies.at(-1)?.reasoning_effort, 'low')
  } finally {
    llm.restore()
  }
})

test('vision gets the level too', async () => {
  const llm = fakeLlm({ thinking: () => 'xhigh' })
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const file = join(root, 'one.png')
    await writeFile(file, png)
    await llm.auxiliary.analyzeImage(file, 'what is it', { provider: 'prova', model: 'm' })
    assert.deepEqual(llm.bodies.at(-1)?.reasoning_effort, 'xhigh')
  } finally {
    llm.restore()
  }
})

/** Every setting at rest, so one test's choices do not leak into the next one's file. */
function baseSettings(): HostSettingsValues {
  return {
    gatewayURL: 'http://gateway.example.invalid:20128/v1',
    apiKey: '',
    models: [],
    defaultModel: { provider: 'omniroute', model: 'strata/qwen3.8-flash-next' },
    thinking: 'low',
    resumeSweep: false,
    requireLogin: false,
    hfToken: '',
    autoSetup: false,
    agentChat: 'auto',
    agentMaxSteps: 8,
    agentMaxJobs: 6,
    agentWaitSeconds: 300,
    agentConfirmSeconds: 15,
    agentTurnSeconds: 900,
  }
}

test('the field is saved and read back, and a value that is not a tier means the default', async () => {
  const file = join(root, 'host-settings.json')
  const base = baseSettings()
  const settings = await createHostSettings({ file, passwordFile: join(root, 'password'), base, envKey: undefined, providers: ['local'], providerFor: () => 'local' })
  assert.equal(settings.current().thinking, 'low')

  // A tier the gateway declares is saved even if the code does not name it.
  await settings.save({ thinking: 'xhigh' })
  assert.equal(settings.current().thinking, 'xhigh')
  // A value that does not have the shape of a tier is dropped: the previous one stays.
  await settings.save({ thinking: 'Massimo!' })
  assert.equal(settings.current().thinking, 'xhigh')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).thinking, 'xhigh')

  // A hand-written file with an impossible value does not reach the gateway.
  await writeFile(file, JSON.stringify({ thinking: 'Altissimo!' }))
  const again = await createHostSettings({ file, passwordFile: join(root, 'password'), base, envKey: undefined, providers: ['local'], providerFor: () => 'local' })
  assert.equal(again.current().thinking, 'low')
})

test('the agent confirmation limit is saved, and only a whole number of seconds is taken', async () => {
  const file = join(root, 'confirm-settings.json')
  const base = baseSettings()
  const settings = await createHostSettings({ file, passwordFile: join(root, 'password'), base, envKey: undefined, providers: ['local'], providerFor: () => 'local' })
  // The confirmed default: a clip up to fifteen seconds runs without asking.
  assert.equal(settings.current().agentConfirmSeconds, AGENT_LIMITS_DEFAULT.confirmSeconds)

  // What the settings page writes: a whole number of seconds.
  await settings.save({ agentConfirmSeconds: 40 })
  assert.equal(settings.current().agentConfirmSeconds, 40)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).agentConfirmSeconds, 40)

  // A value no clip can have (zero, past an hour, a fraction) leaves the last one.
  for (const refused of [0, 3_601, 12.5]) {
    await settings.save({ agentConfirmSeconds: refused })
    assert.equal(settings.current().agentConfirmSeconds, 40, `took ${String(refused)}`)
  }

  // A hand-written file with an impossible value falls back to the default.
  await writeFile(file, JSON.stringify({ agentConfirmSeconds: 0 }))
  const again = await createHostSettings({ file, passwordFile: join(root, 'password'), base, envKey: undefined, providers: ['local'], providerFor: () => 'local' })
  assert.equal(again.current().agentConfirmSeconds, AGENT_LIMITS_DEFAULT.confirmSeconds)
})
