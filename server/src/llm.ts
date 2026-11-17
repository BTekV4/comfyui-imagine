/**
 * The two LLM surfaces the vendored Imagine code reads off its context —
 * `llm.stream` for text passes and `auxiliary.analyzeImage` for looking at a
 * file — implemented against OpenAI-compatible endpoints (OmniRoute here).
 *
 * In DSH these came from `llm-pi-ai` and the auxiliary service; the shapes are
 * the ones `tool-comfy/imagine-models.ts` and `edit-prompt.ts` declare.
 */
import { mkdtemp, open, readFile } from 'node:fs/promises'
import { rmWithRetry } from '../vendor/retry-fs/index.ts'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { mediaTypeOfExt, sniffMedia } from '../../shared/media-types.ts'
import { frameAt } from '../vendor/tool-comfy/media-tools.ts'
import { isThinkingLevel, THINKING_DEFAULT, type ThinkingLevel } from '../../shared/host-settings.ts'
import type { ModelRoute } from '../../shared/imagine-types.ts'
import { message } from './messages.ts'

/** One provider: where it answers and with which key. */
export interface ProviderConfig {
  readonly baseURL: string
  readonly apiKeyEnv?: string
  readonly apiKey?: string
  /** Extra request headers (opencode-go wants `x-opencode-session`). */
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

interface PiContent {
  readonly type: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

interface PiMessage {
  readonly role: string
  readonly content: string | readonly PiContent[]
}

/** Text and reasoning deltas, the two chunk kinds the callers read. */
export interface StreamChunk {
  readonly type: 'text-delta' | 'reasoning-delta'
  readonly text: string
}

/*
 * No deadline and no token ceiling (user's request, 6/11/2026; the deadline
 * removed from every caller on 16/11/2026).
 *
 * A token ceiling truncates the reasoning of a thinking model: on 28/10 a
 * vision call at 400 tokens came back empty (`finish_reason: length`,
 * `content: ""`) and text at 32k cut the longest answers. A deadline kills a
 * request that is still working, which is worse: the story planner died at
 * 90 s while the provider in `config.yaml` was allowed 600, and the passes
 * that write a song, a caption or a project name each carried their own
 * ninety-to-three-hundred-second cap. A model that is still sending tokens —
 * reasoning included — is not a model that failed, so the studio no longer
 * puts a clock on the whole call.
 *
 * What is left is a clock on SILENCE: a connection that sends nothing for
 * {@link MODEL_SILENCE_MS} (or for the provider's `timeoutMs`, when the
 * config declares one) is dead rather than slow and is given up. Every byte
 * that arrives pushes the deadline back. This is the only place a model call
 * is bounded: the passes above pass no timeout at all.
 *
 * The price: a model stuck in a loop writes as long as the context holds. It
 * is stopped with the button (which aborts the request), by the silence
 * budget, or by closing the process.
 */

/**
 * How long a model call may stay silent before it is given up.
 *
 * A silence budget, not a deadline: the response headers, a reasoning delta,
 * a token of the answer — every byte pushes it back, so a model that keeps
 * working is never interrupted however long it thinks. Ten minutes: the
 * longest wait measured on this deployment before the first byte is the
 * ninety seconds of a cold 32B vision model, and a minute of thinking between
 * two reasoning bursts is ordinary.
 *
 * The deployment's `providers.<name>.timeoutMs` replaces it when it is set;
 * that knob is the user's, and this is the fallback so a config without one
 * still cannot hang forever.
 */
export const MODEL_SILENCE_MS = 10 * 60_000

/** The window one provider gets: its own, or {@link MODEL_SILENCE_MS}. */
export function silenceWindowMs(provider: ProviderConfig): number {
  return typeof provider.timeoutMs === 'number' && provider.timeoutMs > 0 ? provider.timeoutMs : MODEL_SILENCE_MS
}

/** One provider request's clock. */
interface Silence {
  /** Aborts the request when the provider goes quiet; also carries the caller's abort. */
  readonly signal: AbortSignal
  /** Something arrived: push the deadline back. */
  touch(): void
  /** The call is over: stop the clock and drop the listener. */
  stop(): void
}

/**
 * Start watching one provider request.
 *
 * One timer, re-armed on every byte, and the caller's own signal folded in so
 * a closed chat still ends the call. `unref` so a pending call never holds the
 * process open.
 * @param provider - the provider being called, for its silence window.
 * @param caller - the signal of whoever asked, when there is one.
 * @returns the signal to hand to `fetch`, and the two functions around it.
 */
function silenceFor(provider: ProviderConfig, caller?: AbortSignal): Silence {
  const window = silenceWindowMs(provider)
  const controller = new AbortController()
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
  const touch = (): void => {
    if (controller.signal.aborted) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(cancel, window)
    timer.unref()
  }
  if (caller?.aborted === true) cancel()
  else caller?.addEventListener('abort', cancel, { once: true })
  touch()
  return { signal: controller.signal, touch, stop }
}

/**
 * The longest side a still is given to the vision model.
 *
 * A 1080x1920 PNG took 38-59 s per look on mimo; `social` measured that the
 * same picture fitted into 768 px as a JPEG answers in 7-15 s. 1024 keeps a
 * little more detail for the edit passes, which read faces.
 */
const VISION_MAX_SIDE = 1024

/**
 * The parameters that tell the model how much to think: `reasoning_effort`
 * with the level, which the gateway accepts as is (verified on 6/11/2026:
 * `none` produces no reasoning characters, the other three produce more and
 * more).
 * @param level - the level in force.
 * @returns the fields to add to the request body.
 */
export function thinkingBody(level: ThinkingLevel): Record<string, unknown> {
  return { reasoning_effort: level }
}

/** Stills under this size go to the model as they are. */
const VISION_SHRINK_ABOVE_BYTES = 400 * 1024

/** What one look may be told beyond the file and the prompt. */
export interface AnalyzeOptions {
  /** Aborts the request: a caller that gave up must not keep the model busy. */
  readonly signal?: AbortSignal
  /** Longest side for a still; 0 sends the file as it is. */
  readonly maxSide?: number
}

export function keyOf(provider: ProviderConfig): string | undefined {
  if (provider.apiKey !== undefined && provider.apiKey !== '') return provider.apiKey
  const value = provider.apiKeyEnv === undefined ? undefined : process.env[provider.apiKeyEnv]
  return value === undefined || value === '' ? undefined : value
}

function toOpenAiContent(content: PiMessage['content']): unknown {
  if (typeof content === 'string') return content
  return content.map((part) => {
    if (part.type === 'image' && part.data !== undefined) {
      return { type: 'image_url', image_url: { url: `data:${part.mimeType ?? 'image/png'};base64,${part.data}` } }
    }
    return { type: 'text', text: part.text ?? '' }
  })
}

/** The types {@link sniffMime} takes from a file's extension. */
const NAMED_MIMES: ReadonlySet<string> = new Set(['video/mp4', 'image/jpeg', 'image/webp'])

/**
 * The file's real media type from its first bytes. Generated `.webp` files on
 * this deployment are PNGs, and a vision model handed the wrong type refuses
 * the picture, so the extension is only the fallback. A WebM clip is left to
 * the fallback on purpose: it is shrunk to one JPEG frame like a still.
 */
function sniffMime(bytes: Buffer, path: string): string {
  // Any still, and an ISO BMFF clip; WebM and audio fall through to the name.
  const sniffed = sniffMedia(bytes)
  if (sniffed !== undefined && (sniffed.startsWith('image/') || sniffed === 'video/mp4')) return sniffed
  // From the name only an mp4/mov clip, a JPEG or a WebP; everything else
  // (a `.gif`, a `.webm`, no extension) is sent as PNG.
  const named = mediaTypeOfExt(extname(path))?.mime
  return named !== undefined && NAMED_MIMES.has(named) ? named : 'image/png'
}

/** One parsed `data:` line of a chat-completions stream. */
type StreamLine = { readonly done: true } | { readonly done: false; readonly chunks: readonly StreamChunk[] }

/**
 * Read one line of the server-sent stream.
 * @param raw - the line, untrimmed.
 * @returns the deltas it carries (none for a comment or a broken line), or done at `[DONE]`.
 */
function readStreamLine(raw: string): StreamLine {
  const line = raw.trim()
  if (!line.startsWith('data:')) return { done: false, chunks: [] }
  const data = line.slice(5).trim()
  if (data === '[DONE]') return { done: true }
  let parsed: { choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }[] }
  try {
    parsed = JSON.parse(data) as typeof parsed
  } catch {
    return { done: false, chunks: [] }
  }
  const delta = parsed.choices?.[0]?.delta
  const reasoning = delta?.reasoning_content ?? delta?.reasoning
  const chunks: StreamChunk[] = []
  if (typeof reasoning === 'string' && reasoning.length > 0) chunks.push({ type: 'reasoning-delta', text: reasoning })
  if (typeof delta?.content === 'string' && delta.content.length > 0) chunks.push({ type: 'text-delta', text: delta.content })
  return { done: false, chunks }
}

/**
 * The OpenAI-compatible client both surfaces share.
 * @param providers - the configured providers by name, read per call.
 * @param fallbackVision - the route to look with when the caller names none, read per call.
 * @returns the `llm` and `auxiliary` services, and the provider's model list.
 */
export function createLlm(
  providers: () => Readonly<Record<string, ProviderConfig>>,
  fallbackVision: () => ModelRoute | undefined,
  thinking: () => unknown = () => THINKING_DEFAULT,
) {
  /**
   * The level in force, read on every request: the page saves and the next
   * request uses it, without reloading the process. An unknown value
   * (hand-written file) counts as the default.
   */
  const thinkingLevel = (): ThinkingLevel => {
    const value = thinking()
    return isThinkingLevel(value) ? value : THINKING_DEFAULT
  }

  /** How long a provider's `/models` answer is kept as valid. */
  const LEVELS_TTL_MS = 60_000
  /**
   * The last `/models` read, per provider (and its address): the catalogue and
   * the thinking levels of every model come from the same answer. Keyed by
   * model until 2026-11-15, so the settings page opening made two identical
   * requests, and each model picked one more. The read in flight is kept
   * too, so two callers share it; a failed read is dropped.
   */
  const entriesCache = new Map<string, { at: number; entries: Promise<ModelEntryRaw[]> }>()

  /** One `/models` entry: the id and what the gateway declares about the model. */
  interface ModelEntryRaw {
    readonly id?: unknown
    readonly capabilities?: { readonly effort_tiers?: unknown }
  }

  /** The models a provider lists, with their capabilities, at most {@link LEVELS_TTL_MS} old. */
  const modelEntries = async (name: string): Promise<ModelEntryRaw[]> => {
    const key = `${name}\u001f${baseOf(providerOf(name))}`
    const hit = entriesCache.get(key)
    if (hit !== undefined && Date.now() - hit.at < LEVELS_TTL_MS) return await hit.entries
    const entries = fetchModelEntries(name)
    const kept = { at: Date.now(), entries }
    entriesCache.set(key, kept)
    entries.catch(() => { if (entriesCache.get(key) === kept) entriesCache.delete(key) })
    return await entries
  }

  /** One `/models` request to a provider. */
  const fetchModelEntries = async (name: string): Promise<ModelEntryRaw[]> => {
    const provider = providerOf(name)
    const silence = silenceFor(provider)
    try {
      const response = await fetch(`${baseOf(provider)}/models`, {
        headers: headersOf(provider),
        signal: silence.signal,
      })
      silence.touch()
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`HTTP ${String(response.status)}`)
      }
      const body = await response.json() as { data?: ModelEntryRaw[] }
      silence.touch()
      return Array.isArray(body.data) ? body.data : []
    } finally {
      silence.stop()
    }
  }
  const providerOf = (name: string): ProviderConfig => {
    const provider = providers()[name]
    if (provider === undefined) throw new Error(message('llm.unknownProvider', { name }))
    return provider
  }

  const baseOf = (provider: ProviderConfig): string => provider.baseURL.replace(/\/$/, '')

  const headersOf = (provider: ProviderConfig): Record<string, string> => {
    const key = keyOf(provider)
    return { ...key === undefined ? {} : { authorization: `Bearer ${key}` }, ...provider.headers }
  }

  /** POST one chat completion to a provider, watched by the call's silence clock. */
  const post = (provider: ProviderConfig, body: unknown, silence: Silence): Promise<Response> =>
    fetch(`${baseOf(provider)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headersOf(provider) },
      body: JSON.stringify(body),
      signal: silence.signal,
    })

  async function* stream(options: {
    provider: string
    model: string
    messages: readonly unknown[]
    signal?: AbortSignal
  }): AsyncIterable<StreamChunk> {
    const provider = providerOf(options.provider)
    const silence = silenceFor(provider, options.signal)
    try {
      yield* streamWatched(provider, options, silence)
    } finally {
      // The consumer can stop early (`[DONE]`, a closed chat): the clock must
      // not outlive the call.
      silence.stop()
    }
  }

  /** The body of {@link stream}: one request, its clock pushed back per piece. */
  async function* streamWatched(
    provider: ProviderConfig,
    options: { provider: string; model: string; messages: readonly unknown[] },
    silence: Silence,
  ): AsyncIterable<StreamChunk> {
    const response = await post(provider, {
      model: options.model,
      stream: true,
      ...thinkingBody(thinkingLevel()),
      messages: (options.messages as readonly PiMessage[]).map(message => ({
        role: message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user',
        content: toOpenAiContent(message.content),
      })),
    }, silence)
    silence.touch()
    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => '')
      throw new Error(`LLM ${options.provider}/${options.model}: HTTP ${String(response.status)} ${detail.slice(0, 300)}`)
    }
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
      silence.touch()
      buffer += decoder.decode(piece, { stream: true })
      // One cut per chunk: slicing the buffer at every line was quadratic
      // when a chunk carried many lines.
      let start = 0
      let newline = buffer.indexOf('\n', start)
      while (newline >= 0) {
        const line = readStreamLine(buffer.slice(start, newline))
        start = newline + 1
        newline = buffer.indexOf('\n', start)
        if (line.done) return
        yield* line.chunks
      }
      buffer = buffer.slice(start)
    }
    // A stream that ends without `[DONE]` may leave its last line without a
    // newline, and the decoder may hold the end of a multi-byte character:
    // both were dropped until 2026-10-25.
    buffer += decoder.decode()
    for (const raw of buffer.split('\n')) {
      const line = readStreamLine(raw)
      if (line.done) return
      yield* line.chunks
    }
  }

  /**
   * Look at one file on disk and answer the prompt about it.
   *
   * A large still is shrunk to {@link VISION_MAX_SIDE} as a JPEG first; a clip
   * goes as it is. The request honours `options.signal`, so a caller that
   * stopped waiting also stops the model.
   * @param path - absolute path of a still or a clip.
   * @param prompt - the instruction.
   * @param route - the model to look with; the configured eyes otherwise.
   * @param options - abort signal and the still's longest side.
   */
  async function analyzeImage(
    path: string,
    prompt?: string,
    route?: ModelRoute,
    options?: AnalyzeOptions,
  ): Promise<{ text: string; provider: string; model: string }> {
    const target = route ?? fallbackVision()
    if (target === undefined) throw new Error(message('llm.noVisionModel'))
    const maxSide = options?.maxSide ?? VISION_MAX_SIDE
    // One open for the type, the size and, when it goes as it is, the bytes:
    // until 2026-10-25 the file was opened three times.
    let mime: string
    let bytes: Buffer | undefined
    const handle = await open(path, 'r')
    try {
      const head = Buffer.alloc(16)
      // Positional, so the read below still starts at the first byte.
      await handle.read(head, 0, head.length, 0)
      mime = sniffMime(head, path)
      const shrink = mime.startsWith('image/') && maxSide > 0 && (await handle.stat()).size > VISION_SHRINK_ABOVE_BYTES
      if (!shrink) bytes = await handle.readFile()
    } finally {
      await handle.close()
    }
    let scratch: string | undefined
    try {
      if (bytes === undefined) {
        try {
          scratch = await mkdtemp(join(tmpdir(), 'imagine-vision-'))
          const small = await frameAt(path, join(scratch, 'vision.jpg'), { maxSide, quality: 3, timeoutMs: 20_000 })
          bytes = await readFile(small)
          mime = 'image/jpeg'
        } catch {
          // Unshrunk is slower, not wrong.
          bytes = await readFile(path)
        }
      }
      const url = `data:${mime};base64,${bytes.toString('base64')}`
      const media = mime.startsWith('video/')
        ? { type: 'video_url', video_url: { url } }
        : { type: 'image_url', image_url: { url } }
      const provider = providerOf(target.provider)
      const silence = silenceFor(provider, options?.signal)
      let response: Response
      let body: { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } } | undefined
      try {
        response = await post(provider, {
          model: target.model,
          // Vision says how much to think too: a photo asks for no less
          // reasoning than a text, and the two values are the same choice.
          ...thinkingBody(thinkingLevel()),
          messages: [{ role: 'user', content: [media, { type: 'text', text: prompt ?? 'Describe this image.' }] }],
        }, silence)
        silence.touch()
        // A dead connection is stopped by the clock while the body is read.
        body = await response.json().catch(() => undefined) as typeof body
        silence.touch()
      } finally {
        silence.stop()
      }
      if (!response.ok) {
        throw new Error(`vision ${target.provider}/${target.model}: HTTP ${String(response.status)} ${body?.error?.message ?? ''}`)
      }
      const text = body?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || text.trim() === '') throw new Error(message('llm.visionSilent'))
      return { text, provider: target.provider, model: target.model }
    } finally {
      if (scratch !== undefined) await rmWithRetry(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * The ids a provider's `/models` lists, sorted: what the settings page
   * offers from the gateway (at most a minute old).
   * @param name - the provider.
   * @throws when it does not answer or answers an error.
   */
  async function listModels(name: string): Promise<string[]> {
    const entries = await modelEntries(name)
    return entries.map(entry => entry.id).filter((id): id is string => typeof id === 'string').sort()
  }

  /**
   * The thinking levels the gateway declares for a model:
   * `capabilities.effort_tiers` in `/v1/models`.
   *
   * No list of our own: the gateway knows which tiers a model accepts, and a
   * new tier shows up in the selector without touching the code. The
   * provider's `/models` answer is kept for a minute and shared with
   * {@link listModels}: the page asks for both when it opens.
   * @param route - the model in force.
   * @returns the tier names, possibly empty when the gateway says nothing.
   */
  async function thinkingLevels(route: ModelRoute): Promise<readonly string[]> {
    const entries = await modelEntries(route.provider)
    const wanted = entries.find(entry => entry.id === route.model)
    const tiers = wanted?.capabilities?.effort_tiers
    return Array.isArray(tiers)
      ? tiers.filter((tier): tier is string => typeof tier === 'string' && isThinkingLevel(tier))
      : []
  }

  return { llm: { stream }, auxiliary: { analyzeImage }, listModels, thinkingLevels }
}
