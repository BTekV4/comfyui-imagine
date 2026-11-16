/**
 * The one clock on a model call: silence, not a deadline.
 *
 * The passes (story plan, sightings, song caption, project title, swap
 * reading, photo parts, the chat) no longer carry a timeout of their own; the
 * model client gives a call up only when the provider stops sending bytes, and
 * pushes that deadline back on every delta. These tests pin both halves: a
 * provider that keeps streaming is never cut, a provider that goes quiet is.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeFetch } from './helpers/fake-fetch.ts'

const { createLlm, MODEL_SILENCE_MS, silenceWindowMs } = await import('../server/src/llm.ts')

/** The signal the client handed to `fetch`, recorded per call. */
interface Call {
  readonly url: string
  readonly signal?: AbortSignal
}

const fake = fakeFetch<Call>((input, init) => ({
  url: String(input),
  signal: (init as { signal?: AbortSignal } | undefined)?.signal,
}))

/*
 * The silence clock unrefs its timer so a pending call never holds the server
 * open; with nothing else scheduled the test process would exit before it
 * fires, so a referenced interval keeps the loop alive for the file.
 */
let keepAlive: ReturnType<typeof setInterval> | undefined
before(() => { keepAlive = setInterval(() => {}, 1000) })
after(() => { clearInterval(keepAlive) })

/** One server-sent frame carrying a text delta. */
function frame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}

/**
 * A streaming answer: one frame every `gapMs`, and a body that either closes
 * or goes quiet for good. Honours the abort the way the runtime does, so a
 * test can tell a cut stream from a hanging one.
 */
function sseAnswer(parts: readonly string[], gapMs: number, opts: { stall?: boolean } = {}): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const signal = fake.calls[fake.calls.length - 1]?.signal
      signal?.addEventListener('abort', () => {
        try { controller.error(new Error('aborted')) } catch { /* already closed */ }
      }, { once: true })
      void (async () => {
        for (const part of parts) {
          if (signal?.aborted === true) return
          controller.enqueue(encoder.encode(part))
          await new Promise(resolve => setTimeout(resolve, gapMs))
        }
        if (opts.stall === true) return
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      })()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** The text one client stream carries, concatenated. */
async function read(provider: string, timeoutMs: number | undefined): Promise<string> {
  const { llm } = createLlm(() => ({ fake: { baseURL: 'http://fake', ...timeoutMs === undefined ? {} : { timeoutMs } } }), () => undefined)
  let text = ''
  for await (const chunk of llm.stream({ provider, model: 'm', messages: [{ role: 'user', content: 'go' }] })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

test('a provider that keeps streaming is not cut at its silence window', async () => {
  // Twelve deltas, one every 25 ms: a third of a second, five times the
  // sixty-millisecond window. A deadline would end this in the middle.
  fake.answerWith(() => sseAnswer(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(frame), 25))
  const started = Date.now()
  assert.equal(await read('fake', 60), 'abcdefghijkl')
  assert.ok(Date.now() - started >= 250, 'the call really ran past its window')
})

test('a provider that goes quiet is given up at its silence window', async () => {
  // One delta, then nothing at all: the connection is dead, not slow.
  fake.answerWith(() => sseAnswer([frame('first')], 20, { stall: true }))
  const started = Date.now()
  await assert.rejects(read('fake', 60))
  assert.ok(Date.now() - started < 3_000)
  assert.equal(fake.calls[0]?.signal?.aborted, true)
})

test('the configured silence window wins, the built-in one is the fallback', () => {
  assert.equal(silenceWindowMs({ baseURL: 'http://x' }), MODEL_SILENCE_MS)
  assert.equal(silenceWindowMs({ baseURL: 'http://x', timeoutMs: 0 }), MODEL_SILENCE_MS)
  assert.equal(silenceWindowMs({ baseURL: 'http://x', timeoutMs: 1_234 }), 1_234)
})
