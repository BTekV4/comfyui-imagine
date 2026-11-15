/**
 * `ctx.comfy`: a thin REST client for a self-hosted ComfyUI instance —
 * submit an API-format workflow, wait for its history record, fetch produced
 * media, and upload input images. Transport only: capability discovery over
 * workflow graphs lives in `graph.ts`, and the studio's pipeline in
 * `tool-comfy`.
 * @module comfyui
 */

import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { boolean, list, number, object, oneOf, string } from '../../src/config-schema.ts'
import {
  dropOrphanRuns, isOutOfMemory, RESTART_COMMAND_TIMEOUT_MS, sleep, spawnRestart, waitUntilReady,
} from './comfy-restart.ts'
import { hostOsOf, rewriteGraphPaths, type ComfyHostOs } from './paths.ts'
import { ComfyProgressTracker, type ComfyProgress } from './progress.ts'
import {
  ComfyError, type ComfyErrorCode, type ComfyGraph, type ComfyMediaRef, type ComfyNodeOutput, type ComfyRunResult,
  type ComfySubmitResult,
} from './types.ts'

export { ComfyError } from './types.ts'
export type { ComfyGraph } from './types.ts'

/**
 * How long a detected host OS is trusted. A dual-boot host flips between
 * systems by rebooting, which takes longer than this; one `/system_stats` per
 * submit was a request for nothing on every shot of a montage.
 */
const HOST_OS_TTL_MS = 30_000

/**
 * How long {@link ComfyUi.nodeInfo} keeps a class's definition: long enough
 * for the reads one request makes together, short enough that a node edited
 * on the ComfyUI host shows up on the next request.
 */
const NODE_INFO_TTL_MS = 5_000

/** What `/object_info/<class>` says of one node class: the part read here. */
interface ComfyNodeInfo {
  readonly input?: {
    readonly required?: Readonly<Record<string, unknown>>
    readonly optional?: Readonly<Record<string, unknown>>
  }
}

/** How submit rewrites relative model/output paths in the graph. */
type ComfyPathStyle = 'auto' | 'posix' | 'nt'

/** Plugin config. */
interface Config {
  /** ComfyUI endpoint base (e.g. `http://127.0.0.1:8188`). Required. */
  baseURL: string
  /** Timeout for one submit-wait-fetch cycle in milliseconds. Default 600000. */
  timeoutMs?: number
  /** History poll interval in milliseconds. Default 1000. */
  pollIntervalMs?: number
  /**
   * Separator rewrite for relative model and output paths on submit.
   * `auto` (default) reads `system.os` from `GET /system_stats` at submit
   * (at most once every 30 s) so a dual-boot host can flip without editing
   * workflow JSON.
   * `posix` / `nt` pin the separator when `/system_stats` is unavailable.
   */
  pathStyle?: ComfyPathStyle
  /**
   * Track live run progress over the WebSocket and ask the server for
   * denoising preview frames on submit. Default true; set false to skip the
   * socket entirely.
   */
  preview?: boolean
  /**
   * Argv that restarts ComfyUI, run when a graph fails for lack of VRAM.
   *
   * The card does not give its memory back between runs — a session of heavy
   * upscales leaves several gigabytes reserved that ComfyUI's own `/free`
   * does not reclaim — so a clip that fits on a fresh process stops fitting
   * later in the day. Only a restart returns it. Left unset the service just
   * reports the failure, which is what a deployment with no way to restart
   * its ComfyUI should do.
   *
   * Argv rather than a shell line: the words are passed to the process as
   * they are written, so nothing here is parsed by a shell.
   */
  restartCommand?: readonly string[]
  /** How long to wait for a restarted ComfyUI to answer again. Default 120000. */
  restartReadyMs?: number
}

const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_RESTART_READY_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 1000

/**
 * How often `/history` is still read while the progress socket watches the
 * run: the socket's end event wakes the wait, and this slow poll only covers
 * an event that never arrives.
 */
const WATCHED_POLL_INTERVAL_MS = 5_000

/** How long one status probe of `/system_stats` and `/queue` may take. */
const STATUS_PROBE_TIMEOUT_MS = 15_000

/** Connection fields an override layer may replace after composition. */
export interface ComfyConnectionOverrides {
  /** ComfyUI endpoint base, e.g. `http://127.0.0.1:8188`. */
  baseURL?: string
  /** Timeout for one submit-wait-fetch cycle in milliseconds. */
  timeoutMs?: number
  /** History poll interval in milliseconds. */
  pollIntervalMs?: number
  /** Separator rewrite for relative model and output paths. */
  pathStyle?: ComfyPathStyle
  /** Whether to track live progress over the WebSocket. */
  preview?: boolean
  /** Argv that restarts ComfyUI. */
  restartCommand?: readonly string[]
  /** How long to wait for a restarted ComfyUI to answer again. */
  restartReadyMs?: number
}

/** The connection settings this process runs with. */
interface ComfyConnection {
  /** ComfyUI endpoint base, without a trailing slash. */
  readonly baseURL: string
  /** Timeout for one submit-wait-fetch cycle in milliseconds. */
  readonly timeoutMs: number
  /** History poll interval in milliseconds. */
  readonly pollIntervalMs: number
  /** Separator rewrite for relative model and output paths. */
  readonly pathStyle: ComfyPathStyle
  /** Whether the WebSocket progress tracking is on. */
  readonly preview: boolean
  /** Argv that restarts ComfyUI, or undefined when the deployment configured none. */
  readonly restartCommand: readonly string[] | undefined
  /** How long to wait for a restarted ComfyUI to answer again. */
  readonly restartReadyMs: number
}

/** One compute device as `/system_stats` reports it. */
interface ComfyServerDevice {
  /** Device name, e.g. `cuda:0 NVIDIA GeForce RTX 5070 Ti`. */
  readonly name: string
  /** Total VRAM in bytes, when the server reports it. */
  readonly vramTotal?: number
  /** Free VRAM in bytes, when the server reports it. */
  readonly vramFree?: number
}

/** What the connected ComfyUI reports about itself and its queue. */
interface ComfyServerReport {
  /** ComfyUI version from `system.comfyui_version`, when reported. */
  readonly version?: string
  /** Host OS from `system.os`, when reported. */
  readonly os?: string
  /** The compute devices the server exposes. */
  readonly devices: readonly ComfyServerDevice[]
  /** Queue depth: how many runs are executing and how many are waiting. */
  readonly queue: { readonly running: number; readonly pending: number }
}

/** One named member of a JSON object, or undefined for any other value. */
function member(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined
}

/** The prompt id of one `/queue` row, `[number, prompt_id, prompt, extra_data, outputs]`. */
function promptIdOf(row: unknown): string | undefined {
  const id: unknown = Array.isArray(row) ? (row as readonly unknown[])[1] : undefined
  return typeof id === 'string' ? id : undefined
}

/** The connection a composed configuration asks for. */
function connectionOf(config: Config): ComfyConnection {
  return {
    baseURL: config.baseURL.replace(/\/+$/, ''),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    pathStyle: pathStyleOf(config.pathStyle),
    preview: config.preview !== false,
    restartCommand: config.restartCommand !== undefined && config.restartCommand.length > 0
      ? [...config.restartCommand]
      : undefined,
    restartReadyMs: config.restartReadyMs ?? DEFAULT_RESTART_READY_MS,
  }
}

/** Normalize a configured path style; anything else is auto-detect. */
function pathStyleOf(value: string | undefined): ComfyPathStyle {
  return value === 'posix' || value === 'nt' ? value : 'auto'
}

/** The WebSocket base for a configured HTTP(S) base URL. */
function wsBaseOf(baseURL: string): string {
  return /^https?:\/\//i.test(baseURL) ? baseURL.replace(/^http/i, 'ws') : baseURL
}

const configSchema = object({
  baseURL: string({ min: 1, required: true }),
  timeoutMs: number({ min: 1, integer: true }),
  pollIntervalMs: number({ min: 1, integer: true }),
  pathStyle: oneOf(['auto', 'posix', 'nt']),
  preview: boolean(),
  restartCommand: list(string()),
  restartReadyMs: number({ min: 1, integer: true }),
})

/**
 * Check the plugin config at boot.
 * @param raw - the `comfy` section of `config.yaml`.
 * @returns the same config, checked.
 * @throws {ConfigError} naming the first field that does not fit.
 */
const Config = (raw: unknown): Config => configSchema(raw, 'comfy') as Config

/**
 * A deadline for one request or run, fused with the caller's cancellation.
 *
 * `AbortSignal.timeout` aborts with a `TimeoutError`; a caller's cancel is an
 * `AbortError`, which is how {@link timedOut} tells the two apart.
 */
function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Whether an aborted signal gave up on a deadline rather than on a cancel. */
function timedOut(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason
  return reason instanceof DOMException && reason.name === 'TimeoutError'
}

/**
 * The exception message of a failed run, read from its history messages.
 * @param messages - the status messages ComfyUI recorded for the run.
 * @returns the exception text, or undefined when the record carries none.
 */
function executionError(
  messages: readonly (readonly [string, Record<string, unknown>])[] | undefined,
): string | undefined {
  for (const entry of messages ?? []) {
    if (entry[0] !== 'execution_error') continue
    const text = entry[1]['exception_message']
    if (typeof text === 'string' && text.length > 0) return text
  }
  return undefined
}

/** The meta-batch id a VHS graph already carries, when it has one. */
/**
 * A fresh VHS meta-batch id, the one shape both the studio and the client
 * stamp on a chain: prefixed like the progress client id, so a chain of ours
 * is recognisable on ComfyUI's queue.
 * @returns a new id.
 */
export function newMetaBatchId(): string {
  return `imagine-${String(Date.now())}-${Math.floor(Math.random() * 0xffffff).toString(16)}`
}

function chainIdOf(graph: ComfyGraph): string | undefined {
  for (const node of Object.values(graph)) {
    if (node.class_type !== 'VHS_BatchManager') continue
    const id = node.inputs['meta_batch_id']
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

/**
 * The ordered media one node produced, deduplicated by file name.
 *
 * A loader publishes its own input through the same key a saver uses: the
 * native `LoadVideo` records it as `{"images": [...], "type": "input"}`, and a
 * run collected that as a product — it was written into the output directory
 * under the caller's declared name, so an object swap or a continuation
 * listed the clip that was fed in as its own result while the generated file
 * took the fallback name behind it. Only the output folder holds generations;
 * an input file is one the caller already owns.
 * @param output - one node's history outputs.
 * @returns the media this node produced, in the order it reported them.
 */
function mediaOf(output: ComfyNodeOutput | undefined): readonly ComfyMediaRef[] {
  if (output === undefined) return []
  const refs = [
    ...(output.images ?? []),
    ...(output.gifs ?? []),
    ...(output.videos ?? []),
    ...(output.audio ?? []),
  ]
  const seen = new Set<string>()
  return refs.filter((ref) => {
    if (ref.type === 'input') return false
    const key = `${ref.type}/${ref.subfolder}/${ref.filename}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A settled run's media, refusing a run that produced none. */
function collect(promptId: string, outputs: Record<string, ComfyNodeOutput>): ComfyRunResult {
  const media = Object.values(outputs).flatMap(output => mediaOf(output))
  if (media.length === 0) {
    throw new ComfyError(`run ${promptId} completed but produced no media`, 'COMFY_FETCH_FAILED')
  }
  return { promptId, media }
}

/**
 * The ComfyUI client. Every request goes through a deadline; a fetch that
 * rejects before the deadline is `COMFY_UNREACHABLE` (or the abort code), a
 * cycle that outlives it is `COMFY_TIMEOUT`.
 */
export class ComfyUi {
  static readonly Config = Config

  // Assigned by {@link useConnection}, which the constructor calls.
  private baseURL!: string
  private timeoutMs!: number
  private pollIntervalMs!: number
  private pathStyle!: ComfyPathStyle
  private preview!: boolean
  private progress: ComfyProgressTracker | undefined
  private restartCommand: readonly string[] | undefined
  private restartReadyMs!: number
  /** The composed configuration, before any {@link applyOverrides} layer. */
  private readonly composed: ComfyConnection
  /** {@link nodeInfo}'s reads, by class: when each started and its answer. */
  private readonly nodeInfos = new Map<string, { readonly at: number; readonly info: Promise<ComfyNodeInfo | undefined> }>()
  /** The host OS {@link detectHostOs} last read, and when. */
  private hostOs: { readonly at: number; readonly os: ComfyHostOs } | undefined

  constructor(config: Config) {
    this.composed = connectionOf(config)
    this.useConnection(this.composed)
  }

  /**
   * Close the progress socket. The host calls it on shutdown: the socket's
   * reconnect loop would otherwise keep the process alive.
   */
  dispose(): void {
    this.progress?.dispose()
    this.progress = undefined
  }

  /**
   * Replace connection fields from an override layer, keeping the ones it omits.
   *
   * The Imagine settings page writes its choices to a file outside the profile
   * composition; the plugin that reads it hands them here at boot. A changed
   * endpoint or preview flag rebuilds the progress socket, whose URL is fixed
   * at construction.
   * @param overrides - the fields the override layer carries.
   */
  applyOverrides(overrides: ComfyConnectionOverrides): void {
    const restart = overrides.restartCommand
    this.useConnection({
      baseURL: (overrides.baseURL ?? this.baseURL).replace(/\/+$/, ''),
      timeoutMs: overrides.timeoutMs ?? this.timeoutMs,
      pollIntervalMs: overrides.pollIntervalMs ?? this.pollIntervalMs,
      pathStyle: overrides.pathStyle === undefined ? this.pathStyle : pathStyleOf(overrides.pathStyle),
      preview: overrides.preview ?? this.preview,
      restartCommand: restart === undefined
        ? this.restartCommand
        : restart.length > 0 ? [...restart] : undefined,
      restartReadyMs: overrides.restartReadyMs ?? this.restartReadyMs,
    })
  }

  /** Adopt one connection, moving the progress socket onto its endpoint. */
  private useConnection(connection: ComfyConnection): void {
    this.baseURL = connection.baseURL
    this.timeoutMs = connection.timeoutMs
    this.pollIntervalMs = connection.pollIntervalMs
    this.pathStyle = connection.pathStyle
    this.preview = connection.preview
    this.restartCommand = connection.restartCommand
    this.restartReadyMs = connection.restartReadyMs
    // Another server may define its nodes differently, and run another system.
    this.nodeInfos.clear()
    this.hostOs = undefined
    this.progress?.dispose()
    this.progress = connection.preview ? new ComfyProgressTracker(wsBaseOf(connection.baseURL)) : undefined
  }

  /** The endpoint this process submits to. */
  get endpoint(): string {
    return this.baseURL
  }

  /** The connection settings in force, overrides included. */
  get connection(): ComfyConnection {
    return {
      baseURL: this.baseURL,
      timeoutMs: this.timeoutMs,
      pollIntervalMs: this.pollIntervalMs,
      pathStyle: this.pathStyle,
      preview: this.preview,
      restartCommand: this.restartCommand,
      restartReadyMs: this.restartReadyMs,
    }
  }

  /** The composed configuration, before any override layer. */
  get composedConnection(): ComfyConnection {
    return this.composed
  }

  /** Whether the deployment configured a restart command. */
  get canRestart(): boolean {
    return this.restartCommand !== undefined
  }

  /**
   * Read the connected server's own report: version, OS, devices, and queue.
   *
   * Both probes ride one deadline, so a server that answers neither is
   * reported as unreachable rather than hanging the caller.
   * @param signal - optional caller cancellation.
   * @returns the server report, with the fields the server actually sent.
   * @throws {ComfyError} when either probe fails or answers a non-OK status.
   */
  async serverReport(signal?: AbortSignal): Promise<ComfyServerReport> {
    const probe = withDeadline(signal, STATUS_PROBE_TIMEOUT_MS)
    const stats = await this.request('/system_stats', { method: 'GET' }, probe)
    if (!stats.ok) {
      await stats.body?.cancel().catch(() => {})
      throw new ComfyError(`ComfyUI answered HTTP ${String(stats.status)} for /system_stats`, 'COMFY_UNREACHABLE')
    }
    const payload = await this.json(stats, 'COMFY_UNREACHABLE')
    const system = member(payload, 'system')
    const version = member(system, 'comfyui_version')
    const os = member(system, 'os')
    const devices = member(payload, 'devices')
    return {
      ...typeof version === 'string' ? { version } : {},
      ...typeof os === 'string' ? { os } : {},
      devices: Array.isArray(devices)
        ? devices.flatMap((entry): ComfyServerDevice[] => {
          const name = member(entry, 'name')
          if (typeof name !== 'string') return []
          const total = member(entry, 'vram_total')
          const free = member(entry, 'vram_free')
          return [{
            name,
            ...typeof total === 'number' ? { vramTotal: total } : {},
            ...typeof free === 'number' ? { vramFree: free } : {},
          }]
        })
        : [],
      queue: await this.queueDepth(probe),
    }
  }

  /**
   * Read how much work the server currently holds.
   * @param signal - optional caller cancellation.
   * @returns how many runs are executing and how many are waiting.
   * @throws {ComfyError} when the queue cannot be read.
   */
  private async queueDepth(signal?: AbortSignal): Promise<{ running: number; pending: number }> {
    const queue = await this.readQueue(signal, 'COMFY_UNREACHABLE', true)
    return { running: queue.running.length, pending: queue.pending.length }
  }

  /**
   * Read `/queue` once. Rows are `[number, prompt_id, prompt, extra_data, outputs]`.
   * @param signal - caller cancellation.
   * @param code - the error code a failure is reported with.
   * @param strict - refuse a non-OK status instead of parsing its body.
   * @returns the running and waiting rows; a lane the server omits is empty.
   */
  private async readQueue(
    signal: AbortSignal | undefined,
    code: ComfyErrorCode,
    strict = false,
  ): Promise<{ running: readonly unknown[]; pending: readonly unknown[]; queue: readonly unknown[] }> {
    const response = await this.request('/queue', { method: 'GET' }, signal)
    if (strict && !response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new ComfyError(`ComfyUI answered HTTP ${String(response.status)} for /queue`, code)
    }
    const payload = await this.json(response, code)
    const lane = (key: string): readonly unknown[] => {
      const value = member(payload, key)
      return Array.isArray(value) ? value : []
    }
    return { running: lane('queue_running'), pending: lane('queue_pending'), queue: lane('queue') }
  }

  /** Remove one waiting prompt from the queue by id. */
  private async deletePending(promptId: string, signal?: AbortSignal): Promise<Response> {
    return await this.request('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    }, signal)
  }

  /**
   * Run the configured restart command and return once it has exited.
   *
   * The server is not waited for: a heavy pipeline stays mute for minutes
   * while it loads, and the caller polls {@link serverReport} for the answer
   * instead of holding one request open for the whole readiness window. Unlike
   * the out-of-memory restart this one runs whatever the queue holds — the
   * user asked for it — so the caller is the one that warns about queued runs.
   * @returns nothing; a command that cannot run or exits non-zero throws.
   * @throws {ComfyError} when no restart command is configured, or it fails.
   */
  async restartServer(): Promise<void> {
    const argv = this.restartCommand
    if (argv === undefined) {
      throw new ComfyError('ComfyUI restart is not configured', 'COMFY_UNREACHABLE')
    }
    await spawnRestart(argv, AbortSignal.timeout(RESTART_COMMAND_TIMEOUT_MS))
  }

  /**
   * One call to the setup routes of the comfyui-imagine node pack
   * (`/imagine/setup/<route>`), which installs what a graph needs.
   * @param route - `status`, `check`, `install` or `restart`.
   * @param body - the JSON body, for the POST routes.
   * @param headers - extra headers (the Hugging Face token for `install`).
   * @param signal - caller cancellation.
   * @returns the parsed answer, or undefined when this ComfyUI does not have
   *   the pack (the route is not there).
   * @throws {ComfyError} when the pack answers with an error.
   */
  async setupCall(route: 'status' | 'check' | 'install' | 'restart', body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`/imagine/setup/${route}`, body === undefined && route === 'status'
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) }, signal)
    if (response.status === 404 || response.status === 405) {
      await response.body?.cancel().catch(() => {})
      return undefined
    }
    const payload = await this.json(response, 'COMFY_WAIT_FAILED')
    if (!response.ok) {
      const reason = typeof payload === 'object' && payload !== null && 'error' in payload ? String((payload as { error: unknown }).error) : `HTTP ${String(response.status)}`
      throw new ComfyError(`ComfyUI setup: ${reason}`, 'COMFY_WAIT_FAILED')
    }
    return payload
  }

  /**
   * The live progress snapshot for one prompt id, when preview tracking is
   * enabled and the prompt is still being tracked.
   * @param promptId - the prompt id returned by `submit`.
   * @returns the denoising percentage and latest preview frame, if any.
   */
  progressOf(promptId: string): ComfyProgress | undefined {
    return this.progress?.progressOf(promptId)
  }

  /**
   * Submit one API-format workflow and wait until its history record shows a
   * completed execution, then return the ordered media every output node
   * produced.
   *
   * A graph whose VHS_BatchManager carries a `meta_batch_id` is a chained
   * run, followed through the queue block by block instead of waiting on a
   * single prompt id.
   * @param graph - the API-format graph (already parameterized by the caller).
   * @param hooks - `signal`, the caller's cancellation; `onPrompt`, fired as
   *   soon as the prompt id is known, before the history wait, so the caller
   *   can correlate progress; `onRestart`, fired before the one out-of-memory
   *   retry restarts ComfyUI, so the caller can tell the user why the run is
   *   taking a second attempt.
   * @returns the run media.
   */
  async run(
    graph: ComfyGraph,
    hooks: {
      readonly signal?: AbortSignal | undefined
      readonly onPrompt?: ((promptId: string) => void) | undefined
      readonly onRestart?: (() => void) | undefined
      /** This run's deadline instead of the connection's: a graph that loops its own clips runs long. */
      readonly timeoutMs?: number | undefined
    } = {},
  ): Promise<ComfyRunResult> {
    const { signal, onPrompt, onRestart } = hooks
    const runSignal = withDeadline(signal, Math.max(hooks.timeoutMs ?? 0, this.timeoutMs))
    /*
     * The last prompt this call put on the server, so that giving up on it
     * also takes it off. See {@link abandon}.
     */
    let submitted: string | undefined
    const remember = (promptId: string): void => {
      submitted = promptId
      onPrompt?.(promptId)
    }
    /*
     * A chain id means this graph is a VHS meta-batch chain; `submit` stamps
     * that same id onto the adapted graph it sends.
     */
    const chained = chainIdOf(graph) !== undefined
    /*
     * A chain is requeued by ComfyUI itself once per block, each pass under a
     * fresh prompt id, so "the run" is the chain and not the request: every
     * attempt below follows it through the queue rather than waiting on the id
     * this call submitted.
     */
    const attempt = async (): Promise<ComfyRunResult> => {
      if (!chained) return await this.attempt(graph, runSignal, remember)
      return await this.attemptBatched(graph, runSignal, remember)
    }
    try {
      return await attempt()
    } catch (error: unknown) {
      /*
       * One retry, and only for VRAM. The card keeps several gigabytes
       * reserved between runs, so the same clip that fitted this morning
       * stops fitting after a session of upscales; a restarted ComfyUI hands
       * that memory back and the identical graph then completes. A second
       * failure on a fresh process is a real limit — the size asked for does
       * not fit at all — and must reach the user rather than loop.
       */
      /*
       * An absence is not a failure. Loading a heavy model — H3's reference
       * pipeline, say — stops ComfyUI answering HTTP for minutes at a time:
       * the socket accepts and the request dies, which arrives here as
       * `COMFY_UNREACHABLE`. Failing the run on that burned eleven shots of a
       * music video in a row, each one a card-minute of work, for a server
       * that was busy rather than gone. Wait for it to answer and try the
       * graph again; a server that is really down runs out of the readiness
       * window and the error reaches the user then.
       */
      if (error instanceof ComfyError && error.code === 'COMFY_UNREACHABLE' && !runSignal.aborted) {
        await this.waitReady(runSignal)
        /*
         * The prompt already accepted is usually still there: a server busy
         * loading a model stops answering, it does not drop its queue. It is
         * followed again rather than interrupted and sent a second time, which
         * threw away the minutes of card it had already spent. Only a prompt
         * the server no longer knows (a restart lost it) is submitted again.
         * A chain is left to the old path: its blocks run under ids this call
         * did not submit, and picking it up halfway is not worth the risk.
         */
        if (!chained && submitted !== undefined && await this.stillKnown(submitted, runSignal)) {
          const promptId = submitted
          try {
            return collect(promptId, await this.waitHistory(promptId, runSignal))
          } catch (again: unknown) {
            await this.abandon(promptId)
            throw again
          }
        }
        await this.abandon(submitted)
        return await attempt()
      }
      if (!(error instanceof ComfyError) || error.code !== 'COMFY_OUT_OF_MEMORY') {
        await this.abandon(submitted)
        throw error
      }
      if (this.restartCommand === undefined || runSignal.aborted) {
        await this.abandon(submitted)
        throw error
      }
      onRestart?.()
      await this.restart(runSignal)
      return await attempt()
    }
  }

  /**
   * Whether the server still knows a prompt: queued, executing, or settled in
   * its history. A read that fails says no, which sends the graph again as
   * before.
   * @param promptId - the prompt to look for.
   * @param signal - the run's deadline.
   * @returns whether waiting on it can still produce a result.
   */
  private async stillKnown(promptId: string, signal: AbortSignal): Promise<boolean> {
    try {
      const response = await this.request(`/history/${encodeURIComponent(promptId)}`, { method: 'GET' }, signal)
      const history = await this.json(response, 'COMFY_WAIT_FAILED')
      if (member(history, promptId) !== undefined) return true
      const queue = await this.readQueue(signal, 'COMFY_WAIT_FAILED')
      return [...queue.running, ...queue.pending].some(row => promptIdOf(row) === promptId)
    } catch {
      return false
    }
  }

  /**
   * Take a run this client has stopped waiting for off the server.
   *
   * Giving up used to be one-sided: the deadline expired, or an absence sent
   * the graph in a second time, and the prompt already accepted went on
   * executing for nobody. ComfyUI runs one thing at a time, so that prompt
   * keeps the card and the queue — and the next caller waits behind a run
   * whose result will be thrown away.
   *
   * Measured on 2026-09-09: a re-submitted shot wedged in the sampler at
   * 07:05 and was still there at 16:00, nine hours in which ComfyUI executed
   * nothing. Five shots of a music video timed out one after another against
   * it, each one written off as a shot the card refused, and the kernel's OOM
   * killer was what finally freed the queue. The video came out with a hole
   * in the middle and could not be cut together.
   *
   * Best effort by design: a server that is gone cannot be told anything, and
   * that is not a reason to lose the error the caller is already handling.
   * @param promptId - the run to let go of, if one was ever submitted.
   */
  private async abandon(promptId: string | undefined): Promise<void> {
    if (promptId === undefined) return
    // Deliberately without the run's signal: it is aborted, and that abort is
    // the reason this is being called.
    await this.cancel(promptId).catch(() => undefined)
  }

  /** One submit-wait-collect cycle. */
  private async attempt(
    graph: ComfyGraph,
    signal: AbortSignal,
    onPrompt?: (promptId: string) => void,
  ): Promise<ComfyRunResult> {
    const promptId = await this.submit(graph, signal)
    onPrompt?.(promptId)
    return collect(promptId, await this.waitHistory(promptId, signal))
  }

  /**
   * Publish the VHS meta-batch id of the graph about to run.
   *
   * `VHS_BatchManager` keeps its state in the node instance and finds its run
   * through this input, written by `comfyui` into every submitted graph: the
   * blocks a chain requeues carry the id of the chain, and a call that comes
   * later — a retry, another job — would otherwise collide with a chain still
   * running or still holding finished blocks.
   * @param graph - the graph to stamp, modified in place.
   * @param metaBatchOutput - the literal id to write, when the caller pinned one.
   * @returns the id now carried by the graph, or undefined when it has none.
   */
  private stampMetaBatch(graph: ComfyGraph, metaBatchOutput?: string): string | undefined {
    for (const node of Object.values(graph)) {
      if (node.class_type !== 'VHS_BatchManager') continue
      // A literal id from the caller wins over one the graph already carries:
      // the caller is addressing this chain, not reusing a stale one.
      const current = node.inputs['meta_batch_id']
      if (metaBatchOutput === undefined && typeof current === 'string' && current.length > 0) return current
      const id = metaBatchOutput ?? newMetaBatchId()
      node.inputs['meta_batch_id'] = id
      return id
    }
    return undefined
  }

  /**
   * Wait out a VHS meta-batch chain and return the media its last block wrote.
   *
   * The chain is not one request: ComfyUI requeues the graph once per block
   * under a fresh prompt id, and only the final pass closes the encoder and
   * writes the file. The prompt this call submitted is therefore only the way
   * the chain got started; every block is followed through the batch manager,
   * `1` for a block still running and `pending` for one accepted but not
   * started, and the wait ends when an accepted request stops being that
   * manager — the moment ComfyUI has published the final request, which is
   * before it runs, so the caller's own polling collects its output rather
   * than watching for output that a block never wrote.
   *
   * A chain run alone on this server is what makes "the next VHS request" a
   * sound way to tell the blocks apart; Imagine serves one job at a time and
   * refuses the OOM restart while something else is queued.
   * @param graph - the submitted graph, for the caller's cancellation.
   * @param signal - the enclosing run deadline.
   * @param onPrompt - told each block's prompt id, so progress follows the chain.
   * @returns the last block's output nodes.
   */
  private async attemptBatched(
    graph: ComfyGraph,
    signal: AbortSignal,
    onPrompt: (promptId: string) => void,
  ): Promise<ComfyRunResult> {
    const submitted = await this.submit(graph, signal)
    onPrompt(submitted)
    /*
     * The first block's id is read back from the queue and not assumed: VHS
     * answers a requeued block with the id the server chose, and a caller that
     * trusted its own request id would then wait on a prompt that is not the
     * one being processed.
     */
    const first = await this.nextBatchRequest('', signal) ?? submitted
    let last = first
    await this.waitHistory(first, signal)
    for (;;) {
      /*
       * The next block is taken from the queue and only then waited for: the
       * wait ends when its own history record exists, which is exactly when
       * VHS has requeued the one after it. Advancing to the next id without
       * that wait found the same request again on the following pass.
       */
      const next = await this.nextBatchRequest(last, signal)
      if (next === undefined) {
        return collect(last, await this.waitHistory(last, signal))
      }
      last = next
      onPrompt(last)
      await this.waitHistory(last, signal)
    }
  }

  /**
   * The VHS request that has come after the block just finished, if any.
   *
   * The chain is followed through the requests themselves: a meta-batch run is
   * requeued as one new request per block, and each appears in `/queue` before
   * it starts — running, waiting, or accepted-but-not-yet-started. The block
   * just finished is excluded by id, and nothing else in the queue carries a
   * `VHS_VideoCombine` unless someone queued a VHS chain by hand.
   * @param last - the block that just finished.
   * @param signal - the enclosing run deadline.
   * @returns the next block's prompt id, or undefined when the chain has none.
   */
  private async nextBatchRequest(last: string, signal: AbortSignal): Promise<string | undefined> {
    const queue = await this.readQueue(signal, 'COMFY_FETCH_FAILED')
    const idOf = (entry: unknown): string | undefined => {
      const columns: readonly unknown[] = Array.isArray(entry) ? entry : []
      const promptId = columns[1]
      const prompt: unknown = columns[2]
      if (typeof promptId !== 'string' || promptId === last) return undefined
      if (typeof prompt !== 'object' || prompt === null) return undefined
      const nodes: readonly { class_type?: string }[] = Object.values(prompt)
      return nodes.some(node => node.class_type === 'VHS_VideoCombine') ? promptId : undefined
    }
    for (const lane of [queue.running, queue.pending, queue.queue]) {
      const found = lane.map(idOf).find(value => value !== undefined)
      if (found !== undefined) return found
    }
    return undefined
  }

  /**
   * Restart ComfyUI with the configured argv and wait until it answers again.
   *
   * The queue is checked first: Imagine serves one job at a time, but nothing
   * stops someone (Openjutsu, ComfyUI's own page) queueing on the same server,
   * and a restart would kill that run halfway. A busy queue therefore leaves the OOM as it is.
   * @param signal - the enclosing run deadline.
   * @returns nothing; a restart that never comes back throws.
   */
  private async restart(signal: AbortSignal): Promise<void> {
    const argv = this.restartCommand
    if (argv === undefined) return
    if (await this.queueBusy(signal)) {
      throw new ComfyError('ComfyUI ran out of memory and another run is queued', 'COMFY_OUT_OF_MEMORY')
    }
    await spawnRestart(argv, signal)
    await this.waitReady(signal)
  }

  /** Wait until ComfyUI answers `/system_stats` again; see {@link waitUntilReady}. */
  private async waitReady(signal: AbortSignal): Promise<void> {
    await waitUntilReady(async (probe) => {
      const response = await this.request('/system_stats', { method: 'GET' }, probe)
      await response.body?.cancel().catch(() => {})
      return response.ok
    }, this.restartReadyMs, this.pollIntervalMs, signal)
  }

  /**
   * Throw away the runs a previous process of this harness left executing;
   * see {@link dropOrphanRuns}.
   * @param signal - optional caller cancellation.
   * @returns how many runs were dropped; zero when there was nothing of ours.
   */
  async dropOrphans(signal?: AbortSignal): Promise<number> {
    return await dropOrphanRuns({
      read: async probe => await this.readQueue(probe, 'COMFY_WAIT_FAILED'),
      deletePending: async (promptId, probe) => await this.deletePending(promptId, probe),
      interrupt: async (promptId, probe) => { await this.interrupt(promptId, probe) },
    }, this.progress?.clientId, signal)
  }

  /** Whether ComfyUI has anything running or waiting. */
  private async queueBusy(signal: AbortSignal): Promise<boolean> {
    try {
      const queue = await this.readQueue(signal, 'COMFY_WAIT_FAILED')
      return queue.running.length > 0 || queue.pending.length > 0
    } catch {
      // A queue that cannot be read is not proof of work; the restart is the
      // only way out of the OOM, so it goes ahead.
      return false
    }
  }

  /**
   * Submit an API-format workflow.
   * @param graph - the graph to enqueue.
   * @param signal - optional caller cancellation.
   * @returns the prompt id.
   * @throws {ComfyError} `COMFY_GRAPH_REJECTED` when ComfyUI reports node errors.
   */
  async submit(graph: ComfyGraph, signal?: AbortSignal): Promise<string> {
    /*
     * After the graph is adapted, never before: `rewriteGraphPaths` builds a
     * new node object for every node it changes and reuses the rest, so an
     * input written before it — this chain id — is silently dropped. A chain
     * stamped there ran with a fresh manager every block and started over.
     */
    const adapted = await this.adaptGraph(graph, signal)
    // The caller's own id for this chain, and nothing else: it addresses the
    // request it is about to make, so `run` can follow the blocks by the id it
    // put on the graph.
    this.stampMetaBatch(adapted, chainIdOf(graph))
    const body: Record<string, unknown> = { prompt: adapted }
    if (this.progress !== undefined) {
      /*
       * Denoising previews for the pending tile, whatever ComfyUI was started
       * with: `auto` takes TAESD when its decoder is installed, the cheap
       * latent-to-RGB projection otherwise. Updates go back to this client.
       */
      body.extra_data = { preview_method: 'auto', client_id: this.progress.clientId }
    }
    const response = await this.request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, signal)
    const payload = await this.json(response, 'COMFY_SUBMIT_FAILED') as Partial<ComfySubmitResult>
    if (typeof payload.prompt_id !== 'string') {
      throw new ComfyError(`ComfyUI rejected the workflow: ${JSON.stringify(payload)}`, 'COMFY_SUBMIT_FAILED')
    }
    if (payload.node_errors !== undefined && Object.keys(payload.node_errors).length > 0) {
      throw new ComfyError(
        `ComfyUI rejected graph nodes: ${Object.keys(payload.node_errors).join(', ')}`,
        'COMFY_GRAPH_REJECTED',
      )
    }
    this.progress?.track(payload.prompt_id, adapted)
    return payload.prompt_id
  }

  /**
   * Stop a run that ComfyUI has already accepted.
   *
   * One still waiting is removed from the pending queue by id; one that is
   * executing is stopped with {@link interrupt}. Both are attempted, in that
   * order, because the run can move from pending to executing between the
   * caller's decision and this call, and the delete does not report whether
   * it matched anything.
   * @param promptId - the run to stop.
   * @param signal - caller cancellation.
   * @returns nothing; a ComfyUI that refuses either call throws.
   */
  async cancel(promptId: string, signal?: AbortSignal): Promise<void> {
    await this.deletePending(promptId, signal)
    await this.interrupt(promptId, signal)
  }

  /**
   * Stop one prompt if, and only if, it is the one executing.
   *
   * A bare `/interrupt` ends whatever is running, whoever queued it, and this
   * ComfyUI is shared: cancelling an Imagine prompt still in the queue used to
   * kill an Openjutsu render. The queue is read first and the interrupt sent
   * only when this prompt is running; the request also names it
   * (`prompt_id`), which ComfyUI 0.3.4x and later honour by interrupting only
   * that prompt, so a run that ends between the read and the call does not
   * take the next one down with it.
   * @param promptId - the prompt to stop.
   * @param signal - caller cancellation.
   * @returns nothing; a server that cannot be reached throws.
   */
  private async interrupt(promptId: string, signal?: AbortSignal): Promise<void> {
    const queue = await this.readQueue(signal, 'COMFY_WAIT_FAILED')
    if (!queue.running.some(row => promptIdOf(row) === promptId)) return
    const response = await this.request('/interrupt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt_id: promptId }),
    }, signal)
    await response.body?.cancel().catch(() => undefined)
  }

  /**
   * Let the card go of the models it is holding.
   *
   * A chain that renders one window of a clip after another asks for the same
   * models again at every window, and ComfyUI keeps what it loaded. On a
   * sixteen-gigabyte card the second window of a character replacement found
   * the memory already full and took the GPU context down with it (driver
   * `NV_ERR_NO_MEMORY`, 2026-10-15, right after a `sage attention` allocation
   * failure in the window before). Freeing between windows costs the reload
   * and buys the whole chain.
   * @param signal - the run's deadline, so a wedged server cannot hold the turn.
   * @returns nothing; a server that refuses the request throws.
   * @throws {ComfyError} when ComfyUI answers with a failure or cannot be reached.
   */
  async freeMemory(signal?: AbortSignal): Promise<void> {
    const response = await this.request('/free', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    }, signal)
    // The answer carries no body worth reading; the status is the answer.
    await response.body?.cancel().catch(() => undefined)
    if (!response.ok) {
      throw new ComfyError(`ComfyUI refused to free memory (${String(response.status)})`, 'COMFY_SUBMIT_FAILED')
    }
  }

  /**
   * Poll `/history` until the run settles, returning the output-node map.
   * A `status_str` of `error` fails loud.
   * @param promptId - the run id.
   * @param signal - caller cancellation and the enclosing deadline.
   * @returns the settled run's output nodes, keyed by node id.
   */
  private async waitHistory(promptId: string, signal: AbortSignal): Promise<Record<string, ComfyNodeOutput>> {
    for (;;) {
      if (signal.aborted) {
        const timeout = timedOut(signal)
        throw new ComfyError(
          timeout ? `ComfyUI run ${promptId} timed out` : 'ComfyUI wait aborted',
          timeout ? 'COMFY_TIMEOUT' : 'COMFY_WAIT_FAILED',
        )
      }
      const response = await this.request(`/history/${encodeURIComponent(promptId)}`, { method: 'GET' }, signal)
      const payload = await this.json(response, 'COMFY_WAIT_FAILED') as Record<string, {
        status?: { status_str?: string; messages?: readonly (readonly [string, Record<string, unknown>])[] }
        outputs?: Record<string, ComfyNodeOutput>
      }>
      const record = payload[promptId]
      if (record !== undefined) {
        if (record.status?.status_str === 'error') {
          // The record carries the Python exception; without it every failure
          // reached the caller as "failed" and an OOM was indistinguishable
          // from a bad graph.
          const reason = executionError(record.status.messages)
          throw new ComfyError(
            reason === undefined ? `ComfyUI run ${promptId} failed` : `ComfyUI run ${promptId} failed: ${reason}`,
            reason !== undefined && isOutOfMemory(reason) ? 'COMFY_OUT_OF_MEMORY' : 'COMFY_WAIT_FAILED',
          )
        }
        if (record.status?.status_str === 'success' || record.outputs !== undefined) {
          return record.outputs ?? {}
        }
      }
      await this.pauseHistory(promptId, signal)
    }
  }

  /**
   * The pause between two reads of `/history`.
   *
   * While the progress socket watches the prompt the read is slow and the
   * socket's end event wakes it; without the socket, or once the end was
   * announced (the record can land a moment after the event), it is the
   * configured interval. Woken early by a cancel either way, so the wait
   * reports it at once.
   * @param promptId - the run being waited on.
   * @param signal - caller cancellation and the enclosing deadline.
   */
  private async pauseHistory(promptId: string, signal: AbortSignal): Promise<void> {
    const progress = this.progress
    if (progress === undefined || !progress.watching(promptId)) {
      await sleep(this.pollIntervalMs, signal)
      return
    }
    const wake = new AbortController()
    const stop = progress.onEnd(promptId, () => { wake.abort() })
    try {
      await sleep(Math.max(this.pollIntervalMs, WATCHED_POLL_INTERVAL_MS), AbortSignal.any([signal, wake.signal]))
    } finally {
      stop()
    }
  }

  /**
   * Download one produced media file straight to disk.
   *
   * Streamed, not buffered: a clip can run to hundreds of megabytes. A failed
   * transfer removes the partial file.
   * @param ref - the media reference from a run result.
   * @param path - where to write it; replaced when it exists.
   * @param signal - optional caller cancellation.
   * @returns how many bytes were written.
   */
  async fetchMediaTo(ref: ComfyMediaRef, path: string, signal?: AbortSignal): Promise<number> {
    const params = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type })
    const response = await this.request(`/view?${params.toString()}`, { method: 'GET' }, signal)
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => {})
      throw new ComfyError(`ComfyUI /view failed (HTTP ${String(response.status)})`, 'COMFY_FETCH_FAILED')
    }
    const out = createWriteStream(path)
    try {
      await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), out, ...signal === undefined ? [] : [{ signal }])
    } catch (error: unknown) {
      await rm(path, { force: true }).catch(() => undefined)
      throw new ComfyError(`ComfyUI /view transfer failed: ${String(error)}`, 'COMFY_FETCH_FAILED', { cause: error })
    }
    return out.bytesWritten
  }

  /**
   * One node class's definition, as `/object_info/<class>` reports it now.
   *
   * Kept for {@link NODE_INFO_TTL_MS} per class, the read in flight included:
   * the lookbook asks for its title and its pose from the same catalogue node
   * at once, and that was two identical requests. A failed read is not kept.
   * A caller that shares a read in flight also shares its cancellation.
   * @param classType - the node's `class_type`.
   * @param signal - optional caller cancellation.
   * @returns the definition, or undefined when ComfyUI does not know the class.
   * @throws {ComfyError} `COMFY_FETCH_FAILED` when `/object_info` refuses.
   */
  private async nodeInfo(classType: string, signal?: AbortSignal): Promise<ComfyNodeInfo | undefined> {
    const now = Date.now()
    const known = this.nodeInfos.get(classType)
    if (known !== undefined && now - known.at < NODE_INFO_TTL_MS) return await known.info
    const info = this.readNodeInfo(classType, signal)
    this.nodeInfos.set(classType, { at: now, info })
    info.catch(() => {
      if (this.nodeInfos.get(classType)?.info === info) this.nodeInfos.delete(classType)
    })
    return await info
  }

  private async readNodeInfo(classType: string, signal?: AbortSignal): Promise<ComfyNodeInfo | undefined> {
    const response = await this.request(`/object_info/${encodeURIComponent(classType)}`, { method: 'GET' }, signal)
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new ComfyError(
        `ComfyUI /object_info/${classType} failed (HTTP ${String(response.status)})`,
        'COMFY_FETCH_FAILED',
      )
    }
    const payload = await this.json(response, 'COMFY_FETCH_FAILED') as Record<string, ComfyNodeInfo | undefined>
    return payload[classType]
  }

  /**
   * Read the values one node input accepts, as ComfyUI reports them now.
   *
   * A combo widget's values come from the node's Python, not from the stored
   * workflow: a catalogue node edited on the ComfyUI host accepts a different
   * list under the same saved graph. Callers that offer the values to a user
   * must therefore read them per request rather than copy them; the few
   * seconds {@link nodeInfo} keeps a class do not change that.
   * @param classType - the node's `class_type`.
   * @param field - the input key, required or optional.
   * @param signal - optional caller cancellation.
   * @returns the accepted values, or undefined when ComfyUI does not know the
   * class or the input is not a combo.
   * @throws {ComfyError} `COMFY_FETCH_FAILED` when `/object_info` refuses.
   */
  async nodeOptions(classType: string, field: string, signal?: AbortSignal): Promise<readonly string[] | undefined> {
    const input = (await this.nodeInfo(classType, signal))?.input
    const spec = input?.required?.[field] ?? input?.optional?.[field]
    /*
     * ComfyUI has described a combo two ways and both are live in one install.
     * The older shape is `[values, options]`, with the list first; the newer one
     * is `['COMBO', {options: values}]`, because the values moved into the
     * options object when the combo gained a `multiselect` flag. Reading only
     * the first left every new-style widget with no values at all — and a
     * deployment can mix them, since each custom node picks its own.
     */
    const head: unknown = Array.isArray(spec) ? (spec as readonly unknown[])[0] : undefined
    const tail: unknown = Array.isArray(spec) ? (spec as readonly unknown[])[1] : undefined
    const values: unknown = Array.isArray(head)
      ? head
      : typeof tail === 'object' && tail !== null && Array.isArray((tail as { options?: unknown }).options)
        ? (tail as { options: readonly unknown[] }).options
        : undefined
    if (!Array.isArray(values)) return undefined
    const strings = (values as readonly unknown[]).filter(value => typeof value === 'string')
    return strings.length === values.length ? strings : undefined
  }

  /**
   * Upload one input image for `LoadImage` nodes.
   * @param name - the file name to present; ComfyUI keys output folders by it.
   * @param bytes - the image bytes.
   * @param signal - optional caller cancellation.
   * @returns the stored reference `{ name, subfolder, type }`.
   */
  async uploadImage(name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<{ name: string; subfolder: string; type: string }> {
    const form = new FormData()
    form.append('image', new Blob([bytes as BlobPart]), name)
    form.append('overwrite', 'true')
    const response = await this.request('/upload/image', { method: 'POST', body: form }, signal)
    const payload = await this.json(response, 'COMFY_UPLOAD_FAILED') as { name?: string; subfolder?: string; type?: string }
    if (typeof payload.name !== 'string') {
      throw new ComfyError('ComfyUI /upload/image returned no name', 'COMFY_UPLOAD_FAILED')
    }
    return {
      name: payload.name,
      subfolder: payload.subfolder ?? '',
      type: payload.type ?? 'input',
    }
  }

  /**
   * Upload one input video for `LoadVideo` nodes. Uses the same input-folder
   * endpoint as images (`POST /upload/image`); ComfyUI keys the folder by
   * the returned name, which `LoadVideo.file` then reads.
   * @param name - the file name to present.
   * @param bytes - the video bytes.
   * @param signal - optional caller cancellation.
   * @returns the stored reference `{ name, subfolder, type }`.
   */
  async uploadVideo(name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<{ name: string; subfolder: string; type: string }> {
    return this.uploadImage(name, bytes, signal)
  }

  /**
   * Rewrite relative model/output paths to the live ComfyUI host separator.
   * A pinned `pathStyle` skips `/system_stats`. Auto-detect failure leaves
   * the graph unchanged so a downed stats endpoint cannot block submit.
   * @param graph - the caller graph (not mutated).
   * @param signal - optional caller cancellation.
   * @returns the graph to POST, possibly rewritten.
   */
  private async adaptGraph(graph: ComfyGraph, signal?: AbortSignal): Promise<ComfyGraph> {
    const hostOs = this.pathStyle === 'auto' ? await this.detectHostOs(signal) : this.pathStyle
    return hostOs === undefined ? graph : rewriteGraphPaths(graph, hostOs)
  }

  /**
   * Read `system.os` from `GET /system_stats`. A missing or unparseable
   * body returns `undefined` so submit can proceed with the stored paths.
   * An answer is kept for {@link HOST_OS_TTL_MS}; a failed read is not.
   * @param signal - optional caller cancellation.
   * @returns the host family, when reported.
   */
  private async detectHostOs(signal?: AbortSignal): Promise<ComfyHostOs | undefined> {
    const known = this.hostOs
    if (known !== undefined && Date.now() - known.at < HOST_OS_TTL_MS) return known.os
    try {
      const response = await this.request('/system_stats', { method: 'GET' }, signal)
      const payload = await this.json(response, 'COMFY_SUBMIT_FAILED') as {
        system?: { os?: unknown }
      }
      const os = typeof payload.system?.os === 'string' ? hostOsOf(payload.system.os) : undefined
      if (os !== undefined) this.hostOs = { at: Date.now(), os }
      return os
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      // Stats probe failed: keep the stored separators rather than abort submit.
      return undefined
    }
  }

  /** One fetch with redirects rejected and network faults classified. */
  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const call: RequestInit = { ...init, redirect: 'error' as const }
    if (signal !== undefined) call.signal = signal
    let response: Response
    try {
      response = await fetch(`${this.baseURL}${path}`, call)
    } catch (error: unknown) {
      if (signal?.aborted) {
        const timeout = timedOut(signal)
        throw new ComfyError(
          timeout ? 'ComfyUI request timed out' : 'ComfyUI request aborted',
          timeout ? 'COMFY_TIMEOUT' : 'COMFY_WAIT_FAILED',
          { cause: error },
        )
      }
      throw new ComfyError(`ComfyUI unreachable: ${String(error)}`, 'COMFY_UNREACHABLE', { cause: error })
    }
    return response
  }

  /** Parse a JSON body, consuming the response even on parse failure. */
  private async json(response: Response, code: ComfyErrorCode): Promise<unknown> {
    try {
      return await response.json()
    } catch (error: unknown) {
      await response.body?.cancel().catch(() => {})
      throw new ComfyError(`ComfyUI returned no JSON (HTTP ${String(response.status)})`, code, { cause: error })
    }
  }
}

