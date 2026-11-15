/**
 * `streamText` gives up on a stream that hangs: the overall deadline, the idle
 * timer and the caller's abort each end the call and abort the stream, for a
 * limited call and for an unlimited one (timeout 0, the chat).
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const { streamText } = await import('../server/vendor/tool-comfy/imagine-models.ts')

const route = { provider: 'p', model: 'm' }

/*
 * streamText unrefs its timers so a pending reading never holds the server
 * open; with nothing else scheduled the test process would exit before they
 * fire, so a referenced interval keeps the loop alive for the file.
 */
let keepAlive: ReturnType<typeof setInterval> | undefined
before(() => { keepAlive = setInterval(() => {}, 1000) })
after(() => { clearInterval(keepAlive) })

/**
 * A stream that yields the given chunks, then hangs. When `honour` is set it
 * ends once the signal aborts, as the runtime does; otherwise it never ends,
 * like a dead connection that ignores the signal.
 */
function hanging(chunks: readonly { type: string; text?: string }[], honour = true) {
  const seen: { signal?: AbortSignal } = {}
  const llm = {
    stream(options: { signal?: AbortSignal }): AsyncIterable<{ type: string; text?: string }> {
      seen.signal = options.signal
      return (async function* () {
        for (const chunk of chunks) yield chunk
        await new Promise<void>((resolve) => {
          if (honour) options.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      })()
    },
  }
  return { llm, seen }
}

test('the overall deadline ends a limited call and aborts the stream', async () => {
  const { llm, seen } = hanging([{ type: 'text-delta', text: 'partial' }])
  const started = Date.now()
  assert.equal(await streamText(llm, route, 'go', 50), undefined)
  assert.ok(Date.now() - started < 2000)
  assert.equal(seen.signal?.aborted, true)
})

test('the deadline ends the call even when the stream ignores the signal', async () => {
  const { llm } = hanging([], false)
  assert.equal(await streamText(llm, route, 'go', 50), undefined)
})

test('the idle timer ends an unlimited call', async () => {
  const { llm, seen } = hanging([{ type: 'reasoning-delta', text: 'thinking' }])
  assert.equal(await streamText(llm, route, 'go', 0, { idleMs: 50 }), undefined)
  assert.equal(seen.signal?.aborted, true)
})

test("the caller's abort ends an unlimited call", async () => {
  const { llm, seen } = hanging([])
  const stop = new AbortController()
  const reading = streamText(llm, route, 'go', 0, { signal: stop.signal })
  setTimeout(() => stop.abort(), 20)
  assert.equal(await reading, undefined)
  assert.equal(seen.signal?.aborted, true)
})

test('a stream that finishes returns its text', async () => {
  const llm = {
    stream(): AsyncIterable<{ type: string; text?: string }> {
      return (async function* () {
        yield { type: 'text-delta', text: 'hello ' }
        yield { type: 'text-delta', text: 'world' }
      })()
    },
  }
  assert.equal(await streamText(llm, route, 'go', 0, { idleMs: 1000 }), 'hello world')
  assert.equal(await streamText(llm, route, 'go', 1000), 'hello world')
})
