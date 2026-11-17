/**
 * The one clock on a speech request: silence, not a deadline.
 *
 * The `speak` and `voice` jobs used to carry a deadline of their own, and a
 * speech service that was still working at that mark had its request aborted.
 * What is left is the rule the model client follows: a connection that keeps
 * sending bytes is never cut, one that goes quiet is given up, and the user's
 * cancel still ends the request at once.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeFetch } from './helpers/fake-fetch.ts'

const { SPEECH_SILENCE_MS, speechClock } = await import('../server/vendor/tool-comfy/speech-silence.ts')
const { speech } = await import('../server/vendor/tool-comfy/speak-job.ts')

/** The signal the request handed to `fetch`, recorded per call. */
interface Call {
  readonly url: string
  readonly signal?: AbortSignal
}

const fake = fakeFetch<Call>((input, init) => ({
  url: String(input),
  signal: (init as { signal?: AbortSignal } | undefined)?.signal,
}))

/*
 * The clock unrefs its timer so a pending request never holds the server open;
 * with nothing else scheduled the test process would exit before it fires, so
 * a referenced interval keeps the loop alive for the file.
 */
let keepAlive: ReturnType<typeof setInterval> | undefined
before(() => { keepAlive = setInterval(() => {}, 1000) })
after(() => { clearInterval(keepAlive) })

/** The speech endpoint a test talks to. */
const target = { baseURL: 'http://fake/v1', model: 'pocket-tts', voice: 'meloni', format: 'mp3' }

/**
 * An audio answer: one piece every `gapMs`, and a body that either closes or
 * goes quiet for good. Honours the abort the way the runtime does, so a test
 * can tell a cut request from a hanging one.
 */
function audioAnswer(pieces: readonly string[], gapMs: number, opts: { stall?: boolean } = {}): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const signal = fake.calls[fake.calls.length - 1]?.signal
      signal?.addEventListener('abort', () => {
        try { controller.error(new Error('aborted')) } catch { /* already closed */ }
      }, { once: true })
      void (async () => {
        for (const piece of pieces) {
          if (signal?.aborted === true) return
          controller.enqueue(encoder.encode(piece))
          await new Promise(resolve => setTimeout(resolve, gapMs))
        }
        if (opts.stall === true) return
        controller.close()
      })()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
}

/** Read one line, with a silence window short enough for a test. */
async function say(windowMs: number, caller?: AbortSignal): Promise<{ bytes: Uint8Array; expired: boolean }> {
  const clock = speechClock(caller, windowMs)
  try {
    const bytes = await speech(target, 'ciao', 'meloni', clock)
    return { bytes, expired: clock.expired() }
  } finally {
    clock.stop()
  }
}

test('the silence window is ten minutes by default', () => {
  assert.equal(SPEECH_SILENCE_MS, 10 * 60_000)
})

test('a service that keeps sending is never cut, however long it takes', async () => {
  // Twelve pieces, one every 25 ms: a third of a second, five times the
  // sixty-millisecond window. A deadline would end this in the middle.
  fake.answerWith(() => audioAnswer(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'], 25))
  const started = Date.now()
  const { bytes, expired } = await say(60)
  assert.equal(new TextDecoder().decode(bytes), 'abcdefghijkl')
  assert.equal(expired, false)
  assert.ok(Date.now() - started >= 250, 'the request really ran past its window')
})

test('a service that goes quiet is given up at the silence window', async () => {
  // One piece, then nothing at all: the connection is dead, not slow.
  fake.answerWith(() => audioAnswer(['first'], 20, { stall: true }))
  const started = Date.now()
  const clock = speechClock(undefined, 60)
  try {
    await assert.rejects(speech(target, 'ciao', 'meloni', clock))
    assert.equal(clock.expired(), true)
  } finally {
    clock.stop()
  }
  assert.ok(Date.now() - started < 3_000)
  assert.equal(fake.calls[0]?.signal?.aborted, true)
})

test('the user cancelling ends the request at once, and is not a timeout', async () => {
  fake.answerWith(() => audioAnswer(['first'], 20, { stall: true }))
  const caller = new AbortController()
  const clock = speechClock(caller.signal, 60_000)
  const started = Date.now()
  setTimeout(() => { caller.abort() }, 30)
  try {
    await assert.rejects(speech(target, 'ciao', 'meloni', clock))
    assert.equal(clock.expired(), false)
  } finally {
    clock.stop()
  }
  assert.ok(Date.now() - started < 3_000)
  assert.equal(fake.calls[0]?.signal?.aborted, true)
})

test('a service that refuses is reported at once, without waiting for the clock', async () => {
  fake.answerWith(() => new Response('nope', { status: 503 }))
  await assert.rejects(say(60_000), /503/)
})
