/**
 * The one clock on a speech-service request: silence, not a deadline.
 *
 * The `speak` and `voice` jobs used to carry a deadline of their own (five
 * minutes for one line, fifteen for a transcription and a synthesis), and a
 * service that was still working at that mark had its request aborted. A
 * speech model can take minutes to load and a long line takes as long as it
 * takes; a service that is still sending bytes is not a service that failed.
 *
 * So the only bound left is a clock on silence, the rule the model client
 * already follows (`server/src/llm.ts`, `MODEL_SILENCE_MS`): a connection that
 * sends nothing for {@link SPEECH_SILENCE_MS} is dead rather than slow, and
 * every byte that arrives pushes the deadline back. The caller's own cancel is
 * folded into the same signal, so the button still stops the request at once.
 * @module tool-comfy/speech-silence
 */

/**
 * How long a speech request may stay silent before it is given up.
 *
 * A silence budget, not a deadline: ten minutes, the same window the model
 * client uses, because a request that has sent nothing for that long is not
 * coming back — a slow synthesis still streams its body, and a service that
 * loaded a model wrote its headers first.
 */
export const SPEECH_SILENCE_MS = 10 * 60_000

/** The clock of one speech request. */
export interface SpeechClock {
  /** The signal to hand to `fetch`; it also carries the caller's cancel. */
  readonly signal: AbortSignal
  /** Something arrived: push the deadline back. */
  touch(): void
  /** The request is over: stop the clock and drop the listener. */
  stop(): void
  /** True when the clock itself ended the request, not the caller. */
  expired(): boolean
}

/**
 * Start watching one speech request.
 *
 * One timer, re-armed on every byte, and the caller's own signal folded in so
 * "Cancel" still ends the request. `unref` so a pending request never holds
 * the process open.
 * @param caller - the job's own cancellation, when there is one.
 * @param windowMs - how long the service may stay mute (tests use a short one).
 * @returns the signal to hand to `fetch`, and the functions around it.
 */
export function speechClock(caller?: AbortSignal, windowMs = SPEECH_SILENCE_MS): SpeechClock {
  const controller = new AbortController()
  let quiet = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    caller?.removeEventListener('abort', cancel)
  }
  const cancel = (): void => {
    stop()
    controller.abort()
  }
  const silence = (): void => {
    quiet = true
    cancel()
  }
  const touch = (): void => {
    if (controller.signal.aborted) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(silence, windowMs)
    timer.unref()
  }
  if (caller?.aborted === true) cancel()
  else caller?.addEventListener('abort', cancel, { once: true })
  touch()
  return { signal: controller.signal, touch, stop, expired: () => quiet }
}

/**
 * Read a response body, pushing the silence clock back on every piece.
 *
 * `response.arrayBuffer()` and `response.json()` read the whole body with no
 * way to see it arrive, and a service that sent its headers and then went
 * quiet would hang there with the timer never touched. The chunks are kept
 * and joined once at the end: the audio of a long line is a few megabytes, not
 * a stream to parse.
 * @param response - the answer whose body is read.
 * @param touch - called on every chunk.
 * @returns the body's bytes.
 */
export async function readBodyTouched(response: Response, touch: () => void): Promise<Uint8Array> {
  const body = response.body
  if (body === null) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      touch()
      chunks.push(value)
      total += value.byteLength
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
