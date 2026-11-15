/**
 * A stand-in for `globalThis.fetch`, so a test never reaches the network.
 *
 * Every call is recorded (in the shape the test asks for) and answered by the
 * handler last given to `answerWith`. The record is emptied before each test
 * and the real `fetch` is put back after the file, so the hooks are
 * registered here, once, instead of in every test file that fakes the
 * network (three until 2026-11-15).
 * @module test/helpers/fake-fetch
 */
import { after, beforeEach } from 'node:test'

/** What a fake call is given: the address and the request options. */
export type FetchInit = { readonly body?: unknown; readonly headers?: unknown } | undefined

/** The recorded calls and the switch for the answer. */
export interface FakeFetch<Call> {
  /** The calls made since the current test started, oldest first. */
  readonly calls: Call[]
  /**
   * Replaces `fetch` with one that records the call and answers with what
   * `handler` returns for it.
   */
  answerWith(handler: (call: Call) => unknown): void
}

/**
 * Fakes the network for the calling test file.
 * @param record - turns a call's arguments into what the test reads back.
 * @returns the recorded calls and `answerWith`.
 */
export function fakeFetch<Call>(record: (input: string | URL, init: FetchInit) => Call): FakeFetch<Call> {
  const calls: Call[] = []
  const realFetch = globalThis.fetch
  beforeEach(() => { calls.length = 0 })
  after(() => { globalThis.fetch = realFetch })
  return {
    calls,
    answerWith(handler) {
      globalThis.fetch = (async (input: string | URL, init?: FetchInit) => {
        const call = record(input, init)
        calls.push(call)
        return handler(call)
      }) as unknown as typeof fetch
    },
  }
}
