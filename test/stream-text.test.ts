/**
 * `streamText` accumulates a reading, reports the reasoning and the first
 * write, and ends when the caller aborts. It puts no clock of its own on the
 * call: a per-pass deadline (thirty to three hundred seconds) used to cut a
 * model that was still working, and the only bound left is the silence clock
 * inside the model client — `llm-silence.test.ts` covers that one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { streamText } = await import('../server/vendor/tool-comfy/imagine-models.ts')

const route = { provider: 'p', model: 'm' }

/**
 * A stream that yields the given chunks, then hangs until the caller aborts.
 * With `honour` false it ignores the signal, like a dead connection.
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

test("the caller's abort ends the call and aborts the stream", async () => {
  const { llm, seen } = hanging([])
  const stop = new AbortController()
  const reading = streamText(llm, route, 'go', { signal: stop.signal })
  setTimeout(() => stop.abort(), 20)
  assert.equal(await reading, undefined)
  assert.equal(seen.signal?.aborted, true)
})

test('a signal that is already aborted never starts the call', async () => {
  const { llm, seen } = hanging([{ type: 'text-delta', text: 'never' }])
  const stop = new AbortController()
  stop.abort()
  assert.equal(await streamText(llm, route, 'go', { signal: stop.signal }), undefined)
  assert.equal(seen.signal, undefined)
})

test('a stream that finishes returns its text', async () => {
  const llm = {
    stream(): AsyncIterable<{ type: string; text?: string }> {
      return (async function* () {
        yield { type: 'reasoning-delta', text: 'thinking' }
        yield { type: 'text-delta', text: 'hello ' }
        yield { type: 'text-delta', text: 'world' }
      })()
    },
  }
  const reasoning: string[] = []
  let wrote = 0
  assert.equal(await streamText(llm, route, 'go', {
    onReasoning: text => reasoning.push(text),
    onWriting: () => { wrote += 1 },
  }), 'hello world')
  assert.deepEqual(reasoning, ['thinking'])
  assert.equal(wrote, 1)
})

test('a stream that throws says nothing', async () => {
  const llm = {
    stream(): AsyncIterable<{ type: string; text?: string }> {
      return (async function* () {
        yield { type: 'text-delta', text: 'half' }
        throw new Error('connection reset')
      })()
    },
  }
  assert.equal(await streamText(llm, route, 'go'), undefined)
})

test('a stream with no text at all says nothing', async () => {
  const { llm } = hanging([{ type: 'reasoning-delta', text: 'only thinking' }])
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 20)
  assert.equal(await streamText(llm, route, 'go', { signal: stop.signal }), undefined)
})
