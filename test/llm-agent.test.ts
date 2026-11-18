/**
 * The tool-aware model client: the tool calls it reads off a stream, the two
 * message shapes a tool turn needs, and the capabilities it reads from
 * `/v1/models`.
 *
 * The gateway is faked at `fetch`, as the silence tests do; no network, no
 * model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeFetch } from './helpers/fake-fetch.ts'
import type { AgentChatMessage, AgentModelEvent } from '../shared/agent-chat.ts'

const { createLlm } = await import('../server/src/llm.ts')

/** One recorded request: its address and the body it sent. */
interface Call {
  readonly url: string
  readonly body?: string
}

const fake = fakeFetch<Call>((input, init) => ({
  url: String(input),
  body: typeof init?.body === 'string' ? init.body : undefined,
}))

/** A streaming answer made of raw `data:` lines. */
function sse(lines: readonly string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const frame = (delta: unknown, finish?: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta, ...finish === undefined ? {} : { finish_reason: finish } }] })}\n\n`

/** One client over a single fake provider. */
function client() {
  return createLlm(() => ({ fake: { baseURL: 'http://fake' } }), () => undefined)
}

test('a streamed answer carries the text, the reasoning, the tool fragments and the finish reason', async () => {
  fake.answerWith(() => sse([
    frame({ reasoning_content: 'ci penso' }),
    frame({ content: 'Ciao' }),
    frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'generate_image', arguments: '' } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: '{"prompt":' } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
    frame({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ]))
  const events: AgentModelEvent[] = []
  const messages: AgentChatMessage[] = [
    { role: 'system', content: 'sei lo studio' },
    { role: 'user', content: 'una x' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'look', arguments: '{}' }] },
    { role: 'tool', content: '{"ok":true}', toolCallId: 'call_0' },
  ]
  for await (const event of client().llm.chat({
    provider: 'fake',
    model: 'm',
    messages,
    tools: [{ type: 'function', function: { name: 'generate_image', description: 'draw', parameters: { type: 'object', properties: {} } } }],
    toolChoice: 'auto',
    parallelToolCalls: false,
  })) events.push(event)

  assert.deepEqual(events.filter(event => event.type === 'reasoning-delta').map(event => event.type === 'reasoning-delta' ? event.text : ''), ['ci penso'])
  assert.deepEqual(events.filter(event => event.type === 'text-delta').map(event => event.type === 'text-delta' ? event.text : ''), ['Ciao'])
  const fragments = events.filter(event => event.type === 'tool-call')
  assert.equal(fragments.length, 3)
  assert.deepEqual(fragments.map(event => event.type === 'tool-call' ? event.arguments ?? '' : ''), ['', '{"prompt":', '"x"}'])
  const finish = events.find(event => event.type === 'finish')
  assert.equal(finish?.type === 'finish' ? finish.reason : undefined, 'tool_calls')

  const body = JSON.parse(fake.calls[0]?.body ?? '{}') as {
    tools?: unknown[]
    tool_choice?: string
    parallel_tool_calls?: boolean
    messages?: Record<string, unknown>[]
  }
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.parallel_tool_calls, false)
  assert.equal(body.tools?.length, 1)
  assert.equal(body.messages?.[2]?.role, 'assistant')
  assert.deepEqual(body.messages?.[2]?.['tool_calls'], [{ id: 'call_0', type: 'function', function: { name: 'look', arguments: '{}' } }])
  assert.equal(body.messages?.[3]?.role, 'tool')
  assert.equal(body.messages?.[3]?.['tool_call_id'], 'call_0')
})

test('what the gateway declares about tool calling is read from /models', async () => {
  fake.answerWith(call => call.url.endsWith('/models')
    ? new Response(JSON.stringify({
      data: [
        { id: 'with', capabilities: { tool_calling: true, vision: true } },
        { id: 'without', capabilities: { tool_calling: false } },
        { id: 'silent' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    : sse(['data: [DONE]\n\n']))
  const { modelCapabilities } = client()
  assert.deepEqual(await modelCapabilities({ provider: 'fake', model: 'with' }), { toolCalling: true, vision: true })
  assert.deepEqual(await modelCapabilities({ provider: 'fake', model: 'without' }), { toolCalling: false })
  assert.deepEqual(await modelCapabilities({ provider: 'fake', model: 'silent' }), {})
  assert.deepEqual(await modelCapabilities({ provider: 'fake', model: 'unknown' }), {})
})
