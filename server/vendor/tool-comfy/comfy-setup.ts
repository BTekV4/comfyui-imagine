/**
 * Before a graph runs: make sure ComfyUI has what it needs.
 *
 * The comfyui-imagine node pack (`comfyui-nodes/comfyui-imagine`) answers
 * `/imagine/setup/check` with the node packs and model files a graph is
 * missing, and installs them on request — only entries of its own manifest,
 * each verified by SHA-256. Here the studio asks it before every run: nothing
 * missing, the run goes on as before; something missing, the user is asked in
 * the chat (unless Settings → «Install automatically» is on), then the pack
 * installs it, ComfyUI restarts when a node pack came in, and the same run
 * continues. A ComfyUI without the pack answers 404 and nothing changes.
 * @module tool-comfy/comfy-setup
 */
import type { ImagineHost } from '../../src/host.ts'
import { message } from '../../src/messages.ts'
import type { ComfyGraph } from '../comfyui/index.ts'
import type { ImagineSetupPlan } from '../../../shared/imagine-types.ts'

/** What `/imagine/setup/check` answers. */
interface CheckAnswer {
  readonly ready: boolean
  readonly packs: readonly { readonly id: string; readonly name: string }[]
  readonly models: readonly { readonly name: string; readonly folder: string; readonly size: number }[]
  readonly bytes: number
  readonly unknownClasses: readonly string[]
  readonly unknownFiles: readonly string[]
  /**
   * File names to write in the graph instead of the ones it has: the variant
   * of a model chosen for this GPU (`krea2_turbo_nvfp4` on an RTX 50 for the
   * graph's `krea2_turbo_int8_convrot`).
   */
  readonly substitutions?: Readonly<Record<string, string>>
}

/** The install task, as `/imagine/setup/status` reports it. */
interface TaskAnswer {
  readonly state: 'idle' | 'running' | 'done' | 'failed'
  readonly step?: string
  readonly file?: string
  readonly done?: number
  readonly total?: number
  readonly etaSeconds?: number | null
  readonly error?: string
  readonly restart?: boolean
}

interface StatusAnswer {
  /** When this ComfyUI process started: it changes once a restart is through. */
  readonly boot?: number
  readonly task: TaskAnswer
}

/** One step of the install, for the job's card. */
export interface SetupProgress {
  readonly percent: number
  readonly etaSeconds?: number
  /** The file being downloaded or the pack being installed; `restart` while ComfyUI restarts. */
  readonly stage: string
}

/** What the job that runs the graph lends the check. */
export interface SetupHooks {
  /** Resolves when the user agrees to install; rejects when they do not, or the job ends. */
  readonly approve?: (plan: ImagineSetupPlan) => Promise<void>
  readonly progress?: (state: SetupProgress) => void
  /** The install is over and the graph is about to run. */
  readonly done?: () => void
  readonly signal?: AbortSignal
}

/** The two settings the check reads, at the moment it reads them. */
export interface SetupSettings {
  readonly hfToken: string
  readonly autoSetup: boolean
}

let settingsOf = (): SetupSettings => ({ hfToken: '', autoSetup: false })

/** How often the install's progress is read. */
let pollMs = 2000

/**
 * Hand the check the host's settings (`main.ts`, at boot).
 * @param read - reads them when a run needs them, so a change on the page applies at once.
 * @param poll - how often to read the install's progress, in ms (the tests make it short).
 */
export function configureComfySetup(read: () => SetupSettings, poll = 2000): void {
  settingsOf = read
  pollMs = poll
}

/** How long ComfyUI may take to come back after the restart that loads new node packs. */
const RESTART_WAIT_MS = 10 * 60_000

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted === true) { reject(signal.reason); return }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, ms)
  const stop = (): void => { clearTimeout(timer); reject(signal?.reason) }
  signal?.addEventListener('abort', stop, { once: true })
})

/**
 * The plan in words, for a message: packs by name, models with their size.
 * @param plan - what is missing.
 * @returns e.g. "Krea 2 Identity Edit, krea2_turbo_int8_convrot.safetensors (13.5 GB)".
 */
export function describePlan(plan: ImagineSetupPlan): string {
  const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`
  return [...plan.packs.map(pack => pack.name), ...plan.models.map(model => `${model.name} (${gb(model.size)})`)].join(', ')
}

/**
 * Make sure ComfyUI can run this graph: nothing to do, or ask, install and
 * restart, then return so the caller submits it.
 * @param ctx - the host, for its ComfyUI client.
 * @param graph - the graph about to be submitted.
 * @param hooks - the job's way to ask the user and to show the progress.
 * @throws {Error} when something is missing that the pack cannot install,
 *   when the user declines, or when the install fails.
 */
export async function ensureComfyReady(ctx: ImagineHost, graph: ComfyGraph, hooks: SetupHooks = {}): Promise<void> {
  const check = await ctx.comfy.setupCall('check', { prompt: graph }, {}, hooks.signal) as CheckAnswer | undefined
  if (check === undefined) return
  if (check.ready) {
    substitute(graph, check.substitutions)
    return
  }
  const unknown = [...check.unknownClasses, ...check.unknownFiles]
  if (unknown.length > 0) throw new Error(message('setup.unknown', { what: unknown.join(', ') }))
  const plan: ImagineSetupPlan = { packs: check.packs.map(({ id, name }) => ({ id, name })), models: check.models, bytes: check.bytes }
  const settings = settingsOf()
  if (!settings.autoSetup) {
    if (hooks.approve === undefined) throw new Error(message('setup.askFirst', { what: describePlan(plan) }))
    await hooks.approve(plan)
  }
  await install(ctx, plan, settings.hfToken, hooks)
  const after = await ctx.comfy.setupCall('check', { prompt: graph }, {}, hooks.signal) as CheckAnswer | undefined
  if (after !== undefined && !after.ready) {
    throw new Error(message('setup.stillMissing', { what: [...after.packs.map(pack => pack.name), ...after.models.map(model => model.name), ...after.unknownClasses, ...after.unknownFiles].join(', ') }))
  }
  substitute(graph, after?.substitutions ?? check.substitutions)
  hooks.done?.()
}

/**
 * Write the files the pack chose into the graph, in place: every input whose
 * value is a key becomes the file it names.
 * @param graph - the graph about to be submitted.
 * @param substitutions - graph value to file name.
 */
function substitute(graph: ComfyGraph, substitutions: Readonly<Record<string, string>> | undefined): void {
  if (substitutions === undefined || Object.keys(substitutions).length === 0) return
  for (const node of Object.values(graph)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (typeof value === 'string' && substitutions[value] !== undefined) node.inputs[key] = substitutions[value]
    }
  }
}

/**
 * Ask the pack to install the plan, follow it, and restart ComfyUI when a node
 * pack came in.
 */
async function install(ctx: ImagineHost, plan: ImagineSetupPlan, token: string, hooks: SetupHooks): Promise<void> {
  const before = await ctx.comfy.setupCall('status', undefined, {}, hooks.signal) as StatusAnswer
  await ctx.comfy.setupCall('install', { packs: plan.packs.map(pack => pack.id), models: plan.models.map(model => model.name) },
    token === '' ? {} : { 'X-HF-Token': token }, hooks.signal)
  let task: TaskAnswer
  for (;;) {
    await sleep(pollMs, hooks.signal)
    task = (await ctx.comfy.setupCall('status', undefined, {}, hooks.signal) as StatusAnswer).task
    if (task.state !== 'running') break
    const total = task.total ?? 0
    hooks.progress?.({
      percent: total > 0 ? Math.min(100, ((task.done ?? 0) / total) * 100) : 0,
      ...typeof task.etaSeconds === 'number' ? { etaSeconds: task.etaSeconds } : {},
      stage: task.file ?? task.step ?? '',
    })
  }
  if (task.state === 'failed') throw new Error(message('setup.failed', { reason: task.error ?? '' }))
  if (task.restart !== true) return
  hooks.progress?.({ percent: 100, stage: 'restart' })
  await ctx.comfy.setupCall('restart', {}, {}, hooks.signal)
  const until = Date.now() + RESTART_WAIT_MS
  for (;;) {
    await sleep(pollMs, hooks.signal)
    // Down for a while is the restart happening: keep asking.
    const now = await ctx.comfy.setupCall('status', undefined, {}, hooks.signal).catch(() => undefined) as StatusAnswer | undefined
    if (now !== undefined && now.boot !== before.boot) return
    if (Date.now() > until) throw new Error(message('setup.restartTimeout', { minutes: RESTART_WAIT_MS / 60_000 }))
  }
}
