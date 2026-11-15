/**
 * Live ComfyUI run progress over the server's WebSocket: one overall
 * percentage for the whole prompt, the latest preview frame, and the time
 * left at the pace the run is going.
 *
 * ComfyUI reports `progress` per NODE. A graph with more than one sampling
 * pass — an object swap, a loop, a refiner, an H3 window — therefore
 * restarted the bar at zero each time the next pass began, and the tile read
 * 8%, 100%, 4% while the run was going perfectly. The percentage here is the
 * weighted share of every node that reports progress: a sampler is worth its
 * step count, any other node its own `max` (SeedVR2's upscaler reports 0..100
 * over the whole clip). The bar walks once, without going back.
 *
 * The time left is the one the ComfyUI terminal shows next to its tqdm bar,
 * read from the same events: weighted steps done over the wall clock, over a
 * short window so one slow first step does not poison the estimate.
 *
 * One persistent socket serves every tracked prompt; it is opened lazily on
 * the first tracked prompt and idles after enough failed reconnects,
 * reopening on the next prompt.
 * @module comfyui/progress
 */

import { randomUUID } from 'node:crypto'
import type { ComfyGraph } from './types.ts'

/** Binary event id ComfyUI uses for preview frames with JSON metadata. */
const PREVIEW_IMAGE_WITH_METADATA = 4

/** Failed reconnects before the socket idles until the next tracked prompt. */
const MAX_RECONNECT_ATTEMPTS = 8

/** Backoff grows by this factor per failed reconnect, capped at RECONNECT_CAP_MS. */
const RECONNECT_BASE_MS = 1_000

const RECONNECT_CAP_MS = 30_000

/** Settled entries are dropped after this age; live entries after LIVE_TTL_MS. */
const SETTLED_TTL_MS = 5 * 60_000

const LIVE_TTL_MS = 60 * 60_000

/**
 * How much recent history the pace is measured over: a long run is timed on
 * its last handful of seconds, not on the whole of it, so a sampler that
 * started slowly still reports an honest "time left".
 *
 * The window is only a preference. An H3 loop spends about 75 s per step, so
 * two readings rarely fall inside any short window; the pace then comes from
 * the last two readings whatever their age, which is why they are kept.
 */
const PACE_WINDOW_MS = 20_000

const PACE_SAMPLES = 60

/**
 * A pace older than this is not a pace: the run is between passes, or stuck.
 * Long enough for a slow sampler's step (75 s on the H3 loops here).
 */
const STALE_TICK_MS = 180_000

/**
 * The socket messages that close a prompt besides the final `executing` with
 * no node: a failure or an interrupt may not send that one.
 */
const ENDING_EVENTS: ReadonlySet<string> = new Set(['execution_success', 'execution_error', 'execution_interrupted'])

/** A JSON-safe snapshot of one prompt's live progress. */
export interface ComfyProgress {
  readonly promptId: string
  /**
   * Overall completion (0..100) of the whole prompt: every pass that reports
   * progress, weighted, never going backwards.
   */
  readonly percent?: number
  /** Sampler step of the last progress event, for the pass that is running. */
  readonly step?: number
  /** Sampler total steps of that pass. */
  readonly maxSteps?: number
  /** The node id currently executing. */
  readonly nodeId?: string
  /** The class type of the executing node (e.g. `KSampler`). */
  readonly nodeClass?: string
  /** The latest preview frame as a JPEG/PNG data URL, when the server sent one. */
  readonly preview?: string
  /** When tracking began for this prompt. */
  readonly startedAt: number
  /** When the last progress/preview/executing event arrived. */
  readonly updatedAt: number
  /** Whether the server reported the execution finished. */
  readonly settled: boolean
  /** Seconds left at the pace the run is going, when one can be measured. */
  readonly etaSeconds?: number
  /** Seconds since the prompt was submitted. */
  readonly elapsedSeconds: number
}

/** One node's share of the overall bar. */
interface Phase {
  /** The node this phase belongs to. */
  readonly id: string
  /** Its weight: sample steps, or the `max` the node reports. */
  weight: number
  /** The weight came from the graph's step count, so it does not move. */
  readonly known: boolean
  value: number
  max: number
  finished: boolean
}

/** One progress reading, kept for the pace over the last few seconds. */
interface Tick {
  readonly at: number
  readonly done: number
}

/** One in-memory tracked prompt. */
interface Entry {
  readonly promptId: string
  /** Node id → class type from the submitted graph, for progress labels. */
  readonly classes: Readonly<Record<string, string>>
  /** Every node whose progress a share of the bar comes from, by node id. */
  readonly phases: Map<string, Phase>
  percent?: number
  step?: number
  maxSteps?: number
  nodeId?: string
  nodeClass?: string
  preview?: string
  readonly startedAt: number
  updatedAt: number
  readonly ticks: Tick[]
  settled: boolean
  /** The server said the run is over, whichever way it ended. */
  ended: boolean
}

/** One parsed preview binary frame from the ComfyUI WebSocket. */
interface PreviewFrame {
  readonly promptId: string
  readonly nodeId: string
  readonly imageType: 'image/jpeg' | 'image/png'
  readonly image: Uint8Array
}

/** One node of an API-format graph. */
type GraphNode = ComfyGraph[string]

/**
 * Parse one binary WebSocket frame into a preview frame.
 * Frames that are not the preview-with-metadata event, are truncated, or
 * carry no prompt/node metadata are ignored (returns `undefined`).
 * @param buffer - the raw binary frame payload.
 * @returns the preview frame, when this is a well-formed preview message.
 */
function parsePreviewFrame(buffer: Uint8Array): PreviewFrame | undefined {
  if (buffer.byteLength < 8) return undefined
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (view.getUint32(0) !== PREVIEW_IMAGE_WITH_METADATA) return undefined
  const metadataLength = view.getUint32(4)
  if (8 + metadataLength > buffer.byteLength) return undefined
  let metadata: Record<string, unknown>
  try {
    metadata = JSON.parse(new TextDecoder().decode(buffer.slice(8, 8 + metadataLength))) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (typeof metadata.prompt_id !== 'string' || typeof metadata.node_id !== 'string') return undefined
  const imageType = metadata.image_type === 'image/png' ? 'image/png' : 'image/jpeg'
  return { promptId: metadata.prompt_id, nodeId: metadata.node_id, imageType, image: buffer.slice(8 + metadataLength) }
}

/** A finite, positive step count off a graph input, or nothing. */
function stepCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

/** The node id an input link points at (`[nodeId, output]`), or nothing. */
function linkOf(value: unknown): string | undefined {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string' ? value[0] : undefined
}

/**
 * The step count a node will sample for, following the links that carry it.
 *
 * A `KSampler` has its own `steps`; a `SamplerCustomAdvanced` takes `sigmas`
 * from a `BasicScheduler`, which may in turn take `steps` from a switch and a
 * primitive — the graphs here do all three. Anything not found means the pass
 * is measured from the `max` it reports once it runs.
 * @param graph - the submitted graph.
 * @param node - the node to read.
 * @param depth - link hops already followed, to stop on a cycle.
 * @returns the step count, or undefined when the graph does not say.
 */
function stepsOf(graph: ComfyGraph, node: GraphNode | undefined, depth: number): number | undefined {
  if (node === undefined || depth > 6) return undefined
  const own = stepCount(node.inputs.steps)
  if (own !== undefined) return own
  for (const value of Object.values(node.inputs)) {
    const next = linkOf(value)
    if (next === undefined) continue
    const found = stepsOf(graph, graph[next], depth + 1)
    if (found !== undefined) return found
  }
  // A primitive behind a switch: its `value` is the step count.
  if (/int/i.test(node.class_type)) return stepCount(node.inputs.value)
  return undefined
}

/**
 * Whether a node class draws samples, as opposed to picking a sampler.
 * @param name - the node's class type.
 * @returns true for `KSampler`, `SamplerCustomAdvanced`, `MiniMaxH3TurboSampler`…
 */
function isSamplerClass(name: string): boolean {
  return name.includes('Sampler') && !name.endsWith('Select')
}

/**
 * How far the run is, over every phase that reports progress.
 * @param entry - the tracked prompt.
 * @returns weighted steps done and total, or undefined before any phase runs.
 */
function weights(entry: Entry): { done: number; total: number } | undefined {
  let done = 0
  let total = 0
  for (const phase of entry.phases.values()) {
    total += phase.weight
    const fraction = phase.finished
      ? 1
      : phase.max > 0 ? Math.min(1, Math.max(0, phase.value / phase.max)) : 0
    done += phase.weight * fraction
  }
  if (total <= 0) return undefined
  return { done, total }
}

/**
 * Seconds left at the pace of the last few progress events, or nothing.
 * @param entry - the tracked prompt.
 * @param now - the moment the answer is being built for.
 * @returns the estimate, whole seconds, at least one.
 */
function paceOf(entry: Entry): number | undefined {
  const ticks = entry.ticks
  const last = ticks[ticks.length - 1]
  if (last === undefined || ticks.length < 2) return undefined
  const recent = ticks.filter(tick => last.at - tick.at <= PACE_WINDOW_MS)
  // Two readings in the window time a fast sampler well; a slow one (75 s a
  // step on the H3 loops) has none, and its pace is the last two readings.
  const first = recent.length >= 2 ? recent[0] : ticks[ticks.length - 2]
  if (first === undefined) return undefined
  const span = last.at - first.at
  const moved = last.done - first.done
  if (span < 400 || moved <= 0) return undefined
  return moved / span
}

function etaOf(entry: Entry, now: number): number | undefined {
  if (entry.settled) return undefined
  const totals = weights(entry)
  if (totals === undefined || totals.done >= totals.total) return undefined
  const last = entry.ticks[entry.ticks.length - 1]
  if (last === undefined || now - last.at > STALE_TICK_MS) return undefined
  const pace = paceOf(entry)
  if (pace === undefined) return undefined
  const left = (totals.total - totals.done) / pace / 1000
  // The reading is from the last event: what passed since then is already
  // spent, so the number walks down between steps instead of standing still.
  return Math.max(1, Math.round(left - (now - last.at) / 1000))
}

/**
 * What every client id this studio submits under begins with. Anything else
 * on the queue belongs to someone else and is left alone.
 */
export const CLIENT_ID_PREFIX = 'imagine-'

/**
 * Tracks submitted prompts over one ComfyUI WebSocket: the owning `ComfyUi`
 * instance creates one and owns its lifetime.
 */
export class ComfyProgressTracker {
  /**
   * Stable client id sent with prompts so the server targets updates here.
   *
   * Prefixed on purpose: it rides along in `extra_data.client_id` and is
   * therefore readable off ComfyUI's own queue, which is how a fresh process
   * tells a run left behind by the previous one — nobody will ever collect it
   * — from a run a person queued on ComfyUI's page. See `ComfyUi.dropOrphans`.
   */
  readonly clientId = `${CLIENT_ID_PREFIX}${randomUUID()}`

  private readonly entries = new Map<string, Entry>()
  private readonly wsURL: string
  private readonly createSocket: (url: string) => WebSocket
  private socket: WebSocket | undefined
  private disposed = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private executingId: string | undefined
  /** Who {@link onEnd} should wake when a prompt ends, by prompt id. */
  private readonly endWaiters = new Map<string, Set<() => void>>()

  constructor(
    wsURL: string,
    createSocket: (url: string) => WebSocket = url => new WebSocket(url),
  ) {
    this.wsURL = wsURL
    this.createSocket = createSocket
  }

  /**
   * Record a submitted prompt's node classes and ensure the socket is live.
   *
   * The sampling nodes are read off the graph here, once: their step counts
   * are what makes the bar span every pass instead of restarting at each one.
   * @param promptId - the id returned by `POST /prompt`.
   * @param graph - the graph that was submitted.
   */
  track(promptId: string, graph: ComfyGraph): void {
    const classes: Record<string, string> = {}
    const phases = new Map<string, Phase>()
    for (const [nodeId, node] of Object.entries(graph)) {
      classes[nodeId] = node.class_type
      if (!isSamplerClass(node.class_type)) continue
      const steps = stepsOf(graph, node, 0)
      // A one-step sampler is the SeedVR2 graphs' pass-through: it reports a
      // single tick, and counting it would fill the bar before the upscale —
      // the node that actually works — has reported anything.
      if (steps === undefined || steps <= 1) continue
      phases.set(nodeId, { id: nodeId, weight: steps, known: true, value: 0, max: steps, finished: false })
    }
    const now = Date.now()
    this.entries.set(promptId, { promptId, classes, phases, startedAt: now, updatedAt: now, ticks: [], settled: false, ended: false })
    this.ensureSocket()
  }

  /**
   * The live progress snapshot for one prompt, when it is being tracked.
   * @param promptId - the prompt id.
   * @returns a JSON-safe snapshot, or `undefined` for unknown prompts.
   */
  progressOf(promptId: string): ComfyProgress | undefined {
    this.prune()
    const entry = this.entries.get(promptId)
    if (entry === undefined) return undefined
    const now = Date.now()
    const eta = etaOf(entry, now)
    return {
      promptId,
      ...entry.settled ? { percent: 100 } : entry.percent === undefined ? {} : { percent: entry.percent },
      ...entry.step === undefined ? {} : { step: entry.step },
      ...entry.maxSteps === undefined ? {} : { maxSteps: entry.maxSteps },
      ...entry.nodeId === undefined ? {} : { nodeId: entry.nodeId },
      ...entry.nodeClass === undefined ? {} : { nodeClass: entry.nodeClass },
      ...entry.preview === undefined ? {} : { preview: entry.preview },
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      settled: entry.settled,
      ...eta === undefined ? {} : { etaSeconds: eta },
      elapsedSeconds: Math.max(0, Math.round((now - entry.startedAt) / 1000)),
    }
  }

  /**
   * Whether the socket can be trusted to announce this prompt's end: it is
   * tracked, not over yet, and the socket is open. A caller polling for the
   * result may then poll slowly and let {@link onEnd} wake it; anything less
   * (an untracked block of a VHS chain, a socket that dropped) and it must
   * keep polling at its own pace, since no event will come.
   * @param promptId - the prompt id.
   * @returns whether an end event can be expected.
   */
  watching(promptId: string): boolean {
    const entry = this.entries.get(promptId)
    return entry !== undefined && !entry.ended && this.socket?.readyState === WebSocket.OPEN
  }

  /**
   * Call `wake` once when the server says the prompt is over (finished,
   * failed or interrupted), or at once when it already said so.
   * @param promptId - the prompt id.
   * @param wake - the callback.
   * @returns a function that stops listening.
   */
  onEnd(promptId: string, wake: () => void): () => void {
    if (this.entries.get(promptId)?.ended === true) {
      wake()
      return () => undefined
    }
    let waiters = this.endWaiters.get(promptId)
    if (waiters === undefined) {
      waiters = new Set()
      this.endWaiters.set(promptId, waiters)
    }
    waiters.add(wake)
    return () => {
      const current = this.endWaiters.get(promptId)
      current?.delete(wake)
      if (current?.size === 0) this.endWaiters.delete(promptId)
    }
  }

  /** Mark a prompt over and wake whoever waits on it. */
  private end(promptId: string): void {
    const entry = this.entries.get(promptId)
    if (entry !== undefined) entry.ended = true
    const waiters = this.endWaiters.get(promptId)
    if (waiters === undefined) return
    this.endWaiters.delete(promptId)
    for (const wake of waiters) wake()
  }

  /**
   * Drop the socket and every tracked prompt, for good: a submit still in
   * flight would otherwise call track() and resurrect the very socket this
   * was meant to close.
   */
  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.socket?.close()
    this.socket = undefined
    this.entries.clear()
    // Wake the waiters: with the socket gone they fall back to their own polling.
    const waiters = [...this.endWaiters.values()].flatMap(set => [...set])
    this.endWaiters.clear()
    for (const wake of waiters) wake()
    this.executingId = undefined
    this.reconnectAttempts = 0
  }

  private ensureSocket(): void {
    if (this.disposed) return
    if (this.socket !== undefined || this.reconnectTimer !== undefined) return
    this.open()
  }

  private open(): void {
    let socket: WebSocket
    try {
      socket = this.createSocket(`${this.wsURL}/ws?clientId=${this.clientId}`)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      this.reconnectAttempts = 0
      socket.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }))
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data
      if (typeof data === 'string') {
        this.applyText(data)
      } else if (data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => {
          this.applyBinary(new Uint8Array(buffer))
        })
      } else if (data instanceof ArrayBuffer) {
        this.applyBinary(new Uint8Array(data))
      }
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      // Nothing will announce an end now: let the waiters poll for it.
      const waiters = [...this.endWaiters.values()].flatMap(set => [...set])
      this.endWaiters.clear()
      for (const wake of waiters) wake()
      if (this.entries.size > 0) this.scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      // The close event follows and owns the reconnect.
    })
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    if (this.reconnectTimer !== undefined) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_CAP_MS)
    this.reconnectAttempts += 1
    const timer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.ensureSocket()
    }, delay)
    // Never hold the process open just to retry a progress socket.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref?: () => void }).unref?.()
    }
    this.reconnectTimer = timer
  }

  private applyText(data: string): void {
    let message: { type?: string; data?: unknown }
    try {
      message = JSON.parse(data) as typeof message
    } catch {
      return
    }
    if (typeof message.data !== 'object' || message.data === null) return
    const payload = message.data as Record<string, unknown>
    if (message.type === 'executing') this.applyExecuting(payload)
    else if (message.type === 'progress') this.applyProgress(payload)
    else if (message.type === 'progress_state') this.applyState(payload)
    else if (ENDING_EVENTS.has(message.type ?? '') && typeof payload.prompt_id === 'string') this.end(payload.prompt_id)
  }

  private applyExecuting(payload: Record<string, unknown>): void {
    const promptId = typeof payload.prompt_id === 'string' ? payload.prompt_id : this.executingId
    // ComfyUI reports the executing node as its graph id: a string, or a
    // number in older builds. Anything else is not a node reference.
    const node = payload.node
    const nodeId = typeof node === 'string' ? node : typeof node === 'number' ? String(node) : undefined
    this.executingId = promptId
    if (nodeId === undefined) {
      const entry = this.executingId === undefined ? undefined : this.entries.get(this.executingId)
      if (entry !== undefined) {
        entry.settled = true
        entry.percent = 100
        entry.updatedAt = Date.now()
      }
      if (this.executingId !== undefined) this.end(this.executingId)
      return
    }
    const entry = promptId === undefined ? undefined : this.entries.get(promptId)
    if (entry !== undefined) {
      entry.nodeId = nodeId
      const nodeClass = entry.classes[nodeId]
      if (nodeClass !== undefined) entry.nodeClass = nodeClass
      entry.updatedAt = Date.now()
    }
  }

  private applyProgress(payload: Record<string, unknown>): void {
    const promptId = typeof payload.prompt_id === 'string' ? payload.prompt_id : this.executingId
    if (promptId === undefined) return
    const entry = this.entries.get(promptId)
    if (entry === undefined) return
    const reported = payload.node
    const nodeId = typeof reported === 'string'
      ? reported
      : typeof reported === 'number' ? String(reported) : entry.nodeId
    if (nodeId === undefined) return
    const value = typeof payload.value === 'number' ? payload.value : undefined
    const max = typeof payload.max === 'number' ? payload.max : undefined
    if (value === undefined || max === undefined || max <= 0) return
    const nodeClass = entry.classes[nodeId]
    let phase = entry.phases.get(nodeId)
    if (phase === undefined) {
      if (nodeClass !== undefined && isSamplerClass(nodeClass) && max <= 1) return
      phase = { id: nodeId, weight: max, known: false, value, max, finished: false }
      entry.phases.set(nodeId, phase)
    } else if (!phase.known) {
      phase.weight = Math.max(phase.weight, max)
    }
    phase.value = value
    phase.max = max
    phase.finished = value >= max
    entry.nodeId = nodeId
    if (nodeClass !== undefined) entry.nodeClass = nodeClass
    entry.step = value
    entry.maxSteps = max
    this.retally(entry, true)
  }

  /**
   * ComfyUI's own registry of every node it started, which says when a pass
   * is finished even if the next node reports no progress of its own.
   * @param payload - the `progress_state` data.
   */
  private applyState(payload: Record<string, unknown>): void {
    const promptId = typeof payload.prompt_id === 'string' ? payload.prompt_id : this.executingId
    if (promptId === undefined) return
    const entry = this.entries.get(promptId)
    if (entry === undefined) return
    const nodes = payload.nodes
    if (typeof nodes !== 'object' || nodes === null) return
    for (const [nodeId, raw] of Object.entries(nodes as Record<string, unknown>)) {
      const phase = entry.phases.get(nodeId)
      if (phase === undefined || typeof raw !== 'object' || raw === null) continue
      const record = raw as Record<string, unknown>
      const max = typeof record.max === 'number' && record.max > 0 ? record.max : undefined
      const value = typeof record.value === 'number' ? record.value : undefined
      if (max !== undefined) {
        phase.max = max
        if (!phase.known) phase.weight = Math.max(phase.weight, max)
      }
      if (value !== undefined) phase.value = value
      if (record.state === 'finished') phase.finished = true
      else if (record.state === 'running') phase.finished = false
    }
    this.retally(entry, false)
  }

  private applyBinary(buffer: Uint8Array): void {
    const frame = parsePreviewFrame(buffer)
    if (frame === undefined) return
    const entry = this.entries.get(frame.promptId)
    if (entry === undefined) return
    entry.preview = `data:${frame.imageType};base64,${Buffer.from(frame.image).toString('base64')}`
    entry.updatedAt = Date.now()
  }

  /**
   * Raise the run's percentage and file the reading the pace is measured on.
   * The bar only ever grows: a phase appearing late (an upscale after the
   * samplers) adds weight to the total, and the run is never reported as
   * having gone backwards because a different node started.
   * @param entry - the tracked prompt.
   * @param tick - a real progress reading, to measure the pace on.
   */
  private retally(entry: Entry, tick: boolean): void {
    const now = Date.now()
    entry.updatedAt = now
    const totals = weights(entry)
    if (totals !== undefined) {
      const percent = Math.min(100, Math.round((totals.done / totals.total) * 100))
      entry.percent = Math.max(entry.percent ?? 0, percent)
      if (tick) entry.ticks.push({ at: now, done: totals.done })
    }
    if (!tick) return
    // Only the count is capped: the age of a reading is what a slow sampler's
    // pace is measured on, so old ones are kept until the cap pushes them out.
    while (entry.ticks.length > PACE_SAMPLES) entry.ticks.shift()
  }

  private prune(): void {
    const now = Date.now()
    for (const [promptId, entry] of this.entries) {
      const age = now - entry.updatedAt
      if ((entry.settled && age > SETTLED_TTL_MS) || age > LIVE_TTL_MS) this.entries.delete(promptId)
    }
  }
}
